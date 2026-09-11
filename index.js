/**
 * DeepSeek peak/off-peak (峰谷) cost guard for the DeepSeek Harness.
 *
 * Every model call in the harness passes through the `llm/stream` waterfall on
 * `ctx.llm`. This plugin wraps that waterfall around the calls a deployment
 * cares about, classifies the dispatch instant against DeepSeek's peak windows
 * (Beijing time, Monday-Friday 09:00-12:00 and 14:00-18:00), and — inside a peak
 * window — asks the human to confirm before any provider I/O happens. Refusing
 * never calls `next()`, so the adapter is never constructed and the call is
 * never billed.
 *
 * The classification arithmetic lives in `./src/peak.js` and the defaults in
 * `./src/config.js`; both are pure and unit tested without a Cordis app.
 *
 * @module dsh-peak-guard
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { APPROVE_LABEL, REJECT_LABEL, loadConfigSchema, normalizeConfig } from './src/config.js'
import { decide, renderPrompt } from './src/peak.js'

/** Package name; also the client module-table id the browser half registers under. */
export const PLUGIN_NAME = 'dsh-peak-guard'

/** Loader display metadata. */
export const name = PLUGIN_NAME

/**
 * Required services.
 *
 * `llm` supplies the waterfall and `agents` resolves the calling agent from
 * `options.sessionId` — the event itself carries no agent. The confirmation
 * seams (`approval`, `userQuestions`) and the sidebar toggle's `webServer` are
 * read optionally with `ctx.get`, because a headless composition mounts none of
 * them and must still load this plugin.
 */
export const inject = ['llm', 'agents']

/**
 * Failure code for a call the human refused.
 *
 * Deliberately outside the provider-retry vocabulary — `EMPTY_RESPONSE`,
 * `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT` — so `dsh-llm-retry` in its
 * default `normal` mode delegates instead of re-running the declined step. A
 * provider configured with `retryPolicy.mode: 'always'` retries any failure, so
 * the repeat-ask memo below is what keeps a refusal from becoming a prompt loop.
 */
export const DECLINED_CODE = 'PEAK_HOUR_DECLINED'

/** Default time a confirmation may wait before it is treated as unanswered. */
const DEFAULT_ASK_TIMEOUT_MS = 0

/** Bound on a `notice` source summary, mirrored from the message vocabulary. */
const NOTICE_SUMMARY_MAX_CHARS = 120

/** Directory holding this module; the default runtime-state file lives beside it. */
const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))

/** Routes the sidebar toggle reads and writes. */
const STATE_ROUTE = '/api/peak-guard/state'

/** Largest accepted toggle body, in bytes. */
const MAX_BODY_BYTES = 1024

/**
 * Read the persisted runtime switch.
 *
 * The file is the sidebar toggle's memory across restarts. A missing, empty, or
 * unreadable file is not an error: it means "never toggled", and the config
 * keeps deciding. Shape is validated so a hand-edited file cannot inject a
 * non-boolean into the gate.
 *
 * @param {string} path - the state file path.
 * @returns {boolean | undefined} the persisted switch, or undefined when unset.
 */
export function readRuntimeState(path) {
  try {
    if (!existsSync(path)) return undefined
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed?.enabled === 'boolean' ? parsed.enabled : undefined
  } catch {
    return undefined
  }
}

/**
 * Persist the runtime switch.
 * @param {string} path - the state file path.
 * @param {boolean} enabled - the new switch value.
 * @throws {Error} when the file cannot be written.
 */
export function writeRuntimeState(path, enabled) {
  writeFileSync(path, `${JSON.stringify({ enabled }, null, 2)}\n`, 'utf8')
}

/**
 * Read a bounded JSON request body.
 *
 * The size guard runs before buffering, so an oversized body is rejected rather
 * than accumulated; the transport may additionally pre-buffer, in which case the
 * declarative body is what gets parsed.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {Promise<unknown>} the parsed body, or undefined when empty/invalid.
 */
async function readJsonBody(req) {
  const declared = Number(req.headers?.['content-length'] ?? 0)
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return undefined
  if (typeof req.body === 'string') {
    if (Buffer.byteLength(req.body) > MAX_BODY_BYTES) return undefined
    try {
      return JSON.parse(req.body)
    } catch {
      return undefined
    }
  }
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  if (chunks.length === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - HTTP status code.
 * @param {unknown} body - JSON-serializable body.
 * @returns {void}
 */
function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/**
 * Describe the current peak/off-peak standing for the toggle's status line.
 * @param {object} config - the normalized config.
 * @param {Date} [now] - the instant to classify.
 * @returns {object} the snapshot fields the sidebar renders.
 */
export function describeStanding(config, now = new Date()) {
  const decision = decide({
    now,
    config,
    call: { provider: config.providerPatterns[0], model: config.modelPatterns[0] },
  })
  return {
    peak: decision.peak,
    offPeak: decision.offPeak,
    localTime: decision.window.localTime,
    weekday: decision.window.weekday,
    timeZone: decision.window.timeZone,
    peakWindows: config.peakWindows.map(window => ({
      start: window.start,
      end: window.end,
      weekdaysOnly: window.weekdaysOnly === true,
      ...(window.label === undefined ? {} : { label: window.label }),
    })),
  }
}

/**
 * Install the peak/off-peak gate.
 * @param {object} ctx - the Cordis plugin context.
 * @param {object} [rawConfig] - the loader-supplied row config.
 * @returns {void}
 */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const timeoutMs = normalizeTimeout(rawConfig.askTimeoutMs)
  const logger = ctx.logger
  const lifetime = new AbortController()
  /**
   * Where the sidebar toggle's switch is remembered across restarts. It may be
   * overridden per deployment; the default lives beside this module so the
   * plugin owns its own state without touching the harness settings document.
   */
  const statePath = typeof rawConfig.statePath === 'string' && rawConfig.statePath.length > 0
    ? rawConfig.statePath
    : join(PACKAGE_ROOT, '.peak-guard-state.json')
  /**
   * The live switch. Seeded from the persisted toggle, falling back to the
   * configured `enabled`; the sidebar writes it. Kept as a mutable binding
   * rather than a rebuilt config so a toggle takes effect on the very next
   * model call without a loader reload.
   */
  let runtimeEnabled = readRuntimeState(statePath) ?? config.enabled
  /** In-flight confirmations, drained on disposal. */
  const active = new Set()
  /** `sessionId → Map<route, { decision, windowKey }>` per-session repeat-ask memo. */
  const memo = new Map()
  /**
   * `route|windowKey → decision` process-wide memo used by `askScope: 'window'`
   * (the default), which is what reduces the confirmation to once per peak
   * window instead of once per model call.
   */
  const sharedMemo = new Map()
  /** Message constructor from the LLM vocabulary; `undefined` if unresolvable. */
  let createUserMessage

  // Resolve the message constructor once. `agent.inject()` takes a
  // `UserMessage`, and `@deepseek-ai/dsh-llm` is present in every composition
  // that mounts the LLM service this plugin already injects — but the plugin
  // stays loadable (logging instead of injecting) if resolution ever fails.
  void import('@deepseek-ai/dsh-llm').then(
    (module) => { createUserMessage = module.createUserMessage },
    (error) => { logger?.debug?.(`dsh-peak-guard: message vocabulary unavailable: ${describe(error)}`) },
  )

  loadConfigSchema().then(
    (schema) => { if (schema === undefined) logger?.debug?.('dsh-peak-guard: Schemastery unavailable; using built-in defaults') },
    (error) => { logger?.warn?.(`dsh-peak-guard: config schema probe failed: ${describe(error)}`) },
  )

  /**
   * Publish the sidebar toggle's read/write route.
   *
   * The browser half cannot reach host memory, so the switch travels over one
   * same-origin JSON route — the same channel the shipped updater panel uses.
   *
   * Timing matters: `ctx.get(name)` is strict, so it answers only once the
   * providing fiber is ACTIVE. This plugin injects `llm` and `agents`, not
   * `webServer`, so at `apply` time the server is frequently still pending and
   * a plain `ctx.get` would silently reach for nothing. `ctx.inject` is the
   * supported wait: the mount runs when the service actually arrives, and the
   * composition simply never calls it when there is no server (headless).
   *
   * Registration is reported to `<statePath>.boot.json` so "the sidebar cannot
   * read the state" is diagnosable from outside the process: that file records
   * whether the route mounted, when, and the error if it did not.
   *
   * @returns {void}
   */
  function mountStateRoute(server) {
    const report = { route: STATE_ROUTE, at: new Date().toISOString() }
    if (server === undefined || typeof server.register !== 'function') {
      report.mounted = false
      report.reason = 'the webServer service is not a route registrar'
      writeBootReport(report)
      logger?.warn?.('dsh-peak-guard: webServer is not a route registrar; the sidebar toggle stays unavailable')
      return
    }
    /** Assemble the snapshot both the toggle and its status line read. */
    const snapshot = () => ({
      ok: true,
      name: PLUGIN_NAME,
      displayName: '峰谷计费守卫',
      enabled: runtimeEnabled,
      configuredEnabled: config.enabled,
      statePath,
      ...describeStanding(config),
    })
    let unregister
    try {
      unregister = server.register({
        kind: 'exact',
        path: STATE_ROUTE,
        handler: async (req, res) => {
          if (req.method === 'GET') {
            sendJson(res, 200, snapshot())
            return
          }
          if (req.method !== 'POST') {
            res.setHeader('allow', 'GET, POST')
            sendJson(res, 405, { ok: false, reason: 'method-not-allowed' })
            return
          }
          const body = await readJsonBody(req)
          if (body === null || typeof body !== 'object' || typeof body.enabled !== 'boolean') {
            sendJson(res, 400, { ok: false, reason: 'enabled-must-be-a-boolean' })
            return
          }
          runtimeEnabled = body.enabled
          try {
            writeRuntimeState(statePath, runtimeEnabled)
          } catch (error) {
            // The switch still took effect in memory; report the durability gap
            // instead of failing the user's click.
            logger?.warn?.(`dsh-peak-guard: could not persist ${statePath}: ${describe(error)}`)
            sendJson(res, 200, { ...snapshot(), persisted: false, persistError: describe(error) })
            return
          }
          logger?.info?.(`dsh-peak-guard: ${runtimeEnabled ? 'enabled' : 'disabled'} from the sidebar toggle`)
          sendJson(res, 200, { ...snapshot(), persisted: true })
        },
      })
      report.mounted = true
    } catch (error) {
      report.mounted = false
      report.reason = describe(error)
      logger?.error?.(`dsh-peak-guard: could not register ${STATE_ROUTE}: ${describe(error)}`)
    }
    writeBootReport(report)
    // `ctx.effect` reverses the disposers its body returns, so handing the
    // route's own disposer back is what removes the route on unload.
    return () => { void unregister?.() }
  }

  /**
   * Record what the host half managed to mount, beside the state file.
   * @param {object} report - the boot report to persist.
   * @returns {void}
   */
  function writeBootReport(report) {
    try {
      writeFileSync(`${statePath}.boot.json`, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    } catch { /* the report is best-effort diagnostics */ }
  }

  // The mount waits for the service rather than sampling it once: this plugin
  // does not inject `webServer`, so at apply time the server may still be
  // pending, and `ctx.get` would then answer undefined and mount nothing.
  // `ctx.inject` is unavailable only on a minimal context, where there is no
  // server to mount into either.
  if (typeof ctx.inject === 'function') {
    ctx.effect(
      () => ctx.inject(['webServer'], (scoped) => mountStateRoute(scoped.get('webServer'))),
      'dsh-peak-guard: mount the sidebar switch route',
    )
  } else {
    logger?.debug?.('dsh-peak-guard: this context cannot inject webServer; the sidebar toggle stays unavailable')
  }

  /**
   * Ask the human through whichever confirmation seam this composition mounts.
   *
   * The approval seam honors the session's own policy: under `never` it answers
   * `rejected` without dispatching anyone, so the guard must not read that as a
   * decision. It checks the effective policy first and falls through to the
   * user-questions seam, which is a separate channel and stays interactive
   * under any approval policy.
   *
   * @param {object} agent - the live calling agent.
   * @param {{ provider: string, model: string }} call - the intercepted route.
   * @param {ReturnType<typeof decide>} decision - the classification.
   * @param {AbortSignal | undefined} signal - the request's live cancellation.
   * @returns {Promise<{ outcome: 'approved' | 'declined' | 'unavailable', channel: string }>} the answer.
   */
  async function askHuman(agent, call, decision, signal) {
    const prompt = renderPrompt({
      call,
      decision,
      showPrices: config.showPrices,
      unaskableNote: config.unaskableAction === 'proceed'
        ? '若当前无人应答，本次调用将按「确认调用」继续。'
        : '若当前无人应答，本次调用将被中止。',
    })
    const approval = ctx.get('approval')
    const session = agent.session
    if (approval !== undefined && typeof approval.request === 'function'
      && typeof approval.effectivePolicy === 'function' && session !== undefined) {
      // `never` auto-rejects before any answerer runs, so asking under it would
      // burn a durable audit pair for a decision the user never made.
      if (approval.effectivePolicy(session) === 'ask') {
        try {
          const outcome = await approval.request({
            agent,
            toolName: 'llm.call',
            reason: `${prompt.question}\n${prompt.detail}`,
            ...signal === undefined ? {} : { signal },
          })
          if (outcome === 'allowed-once') return { outcome: 'approved', channel: 'approval' }
          if (outcome === 'rejected' || outcome === 'cancelled') return { outcome: 'declined', channel: 'approval' }
        } catch (error) {
          logger?.warn?.(`dsh-peak-guard: approval channel failed, trying user-questions: ${describe(error)}`)
        }
      }
    }

    const questions = ctx.get('userQuestions')
    if (questions !== undefined && typeof questions.ask === 'function') {
      try {
        const answer = await questions.ask({
          agent,
          questions: [{
            id: 'dsh-peak-guard',
            header: '峰谷计费确认',
            question: prompt.question,
            detail: prompt.detail,
            options: prompt.options,
          }],
          ...signal === undefined ? {} : { signal },
        })
        const selected = readSelectedLabel(answer)
        if (selected === APPROVE_LABEL) return { outcome: 'approved', channel: 'user-questions' }
        if (selected === REJECT_LABEL) return { outcome: 'declined', channel: 'user-questions' }
        // An empty or unrecognised selection is a dismissal, not an approval;
        // record the raw shape so a surprising answer is diagnosable.
        logger?.warn?.(
          `dsh-peak-guard: user-questions returned an unrecognised answer `
          + `(${describeAnswer(answer)}); treating it as unanswered`,
        )
        return { outcome: 'unavailable', channel: 'user-questions' }
      } catch (error) {
        logger?.warn?.(`dsh-peak-guard: user-questions channel unavailable: ${describe(error)}`)
      }
    }
    return { outcome: 'unavailable', channel: 'none' }
  }

  /**
   * Read the chosen option label out of either answer shape this seam has
   * shipped: the current `{ answers: [{ id, selected, custom }] }` and the
   * earlier provider `{ selected }` form.
   * @param {unknown} answer - whatever the answerer returned.
   * @returns {string | undefined} the selected label, when one was chosen.
   */
  function readSelectedLabel(answer) {
    if (answer === null || typeof answer !== 'object') return undefined
    const item = Array.isArray(answer.answers)
      ? answer.answers.find(entry => entry?.id === 'dsh-peak-guard') ?? answer.answers[0]
      : answer
    if (item === null || typeof item !== 'object') return undefined
    if (Array.isArray(item.selected)) return item.selected[0]
    if (typeof item.selected === 'string') return item.selected
    if (typeof item.custom === 'string' && item.custom.length > 0) return item.custom
    return undefined
  }

  /**
   * Identity of the classification window a decision belongs to, so a memoized
   * answer stops applying once its window has passed.
   * @param {Date} now - the decision instant.
   * @param {ReturnType<typeof decide>} decision - the classification.
   * @returns {string} a key unique per local day and matched window.
   */
  function decisionWindowKey(now, decision) {
    const matched = decision.window.label ?? decision.window.basis
    return `${now.toISOString().slice(0, 10)}|${decision.window.timeZone}|${matched}`
  }

  /**
   * Read one remembered decision for this route and window.
   *
   * The per-agent layer is consulted first so `askScope: 'call'` can stay
   * per-session; the process-wide layer is the fallback, which is what makes a
   * decision survive a call whose session has no live agent (a headless turn)
   * and what carries a `askScope: 'window'` approval to any later call in the
   * same window.
   *
   * @param {object | undefined} agent - the calling agent, when live.
   * @param {{ provider: string, model: string }} call - the intercepted route.
   * @param {string} windowKey - the current window key.
   * @returns {'approved' | 'declined' | undefined} the remembered decision.
   */
  function readMemo(agent, call, windowKey) {
    if (!config.suppressRepeatAsks) return undefined
    const route = `${call.provider}/${call.model}`
    const key = `${route}|${windowKey}`
    const perAgent = agent === undefined ? undefined : memo.get(agent.id)?.get(route)
    if (perAgent !== undefined && perAgent.windowKey === windowKey) return perAgent.outcome
    return sharedMemo.get(key)
  }

  /**
   * Remember one decision for the rest of its window.
   * @param {object | undefined} agent - the calling agent, when live.
   * @param {{ provider: string, model: string }} call - the intercepted route.
   * @param {string} windowKey - the window the decision belongs to.
   * @param {'approved' | 'declined'} outcome - the answer to remember.
   * @returns {void}
   */
  function writeMemo(agent, call, windowKey, outcome) {
    if (!config.suppressRepeatAsks) return
    const route = `${call.provider}/${call.model}`
    if (agent !== undefined) {
      let routes = memo.get(agent.id)
      if (routes === undefined) memo.set(agent.id, routes = new Map())
      routes.set(route, { windowKey, outcome })
    }
    if (config.askScope === 'window') sharedMemo.set(`${route}|${windowKey}`, outcome)
  }

  /**
   * Surface a notice to the user without asking anything. The agent's message
   * injection seam is what presents a plugin notice in the Web GUI; without a
   * live agent (or without the message vocabulary) the notice degrades to the
   * server log so the decision is still recorded somewhere.
   * @param {object | undefined} agent - the calling agent, when live.
   * @param {string} text - the notice body.
   * @param {string} summary - one-line account for the collapsed row.
   * @returns {void}
   */
  function notify(agent, text, summary) {
    if (typeof agent?.inject !== 'function' || createUserMessage === undefined) {
      logger?.info?.(`dsh-peak-guard: ${text}`)
      return
    }
    try {
      agent.inject(createUserMessage({
        content: [{ type: 'text', text }],
        source: {
          kind: 'plugin',
          plugin: name,
          form: 'notice',
          summary: summary.slice(0, NOTICE_SUMMARY_MAX_CHARS),
        },
      }))
    } catch (error) {
      logger?.warn?.(`dsh-peak-guard: could not deliver notice: ${describe(error)}`)
    }
  }

  /**
   * Build the refusal chunk. The loop turns a terminal error `finish` into
   * `agent/request-error` and then a turn-ending `LlmError`, so a declined call
   * fails loudly and visibly instead of silently producing no answer.
   * @param {string} message - the human-facing reason.
   * @returns {object} a terminal error `finish` chunk.
   */
  function declined(message) {
    return {
      type: 'finish',
      reason: { kind: 'error', failure: { message: `[dsh-peak-guard] ${message}`, code: DECLINED_CODE } },
    }
  }

  /**
   * Render when the discounted window opens, for a refusal message.
   *
   * A refusal has to be actionable, and "off-peak is everything else" is not:
   * the useful facts are the clock time and how long the wait is.
   *
   * @param {ReturnType<typeof decide>} decision - the refusing classification.
   * @returns {string} a sentence fragment ending in a full stop.
   */
  function offPeakHint(decision) {
    const next = decision.window.nextOffPeak
    if (next === undefined) return `下次空闲时段：${decision.window.offPeak}。`
    if (!next.withinADay) return `下次空闲时段在一天以外（当前时段配置下无法判定）。`
    return `下次空闲时段 ${next.clock}（约 ${next.countdown}后）。`
  }

  /**
   * Race a confirmation against its timeout, the request's own cancellation,
   * and the plugin lifetime.
   *
   * The tracked promise is the RACE, not the underlying ask: a channel that
   * never settles must not hold disposal open, so the race always settles on
   * its own timers. The request's abort listener is removed once the race
   * settles, so a long-lived request signal does not accumulate listeners
   * across the many steps of one turn.
   *
   * @param {Promise<object>} promise - the in-flight confirmation.
   * @param {AbortSignal | undefined} signal - the request signal.
   * @returns {Promise<{ outcome: string, channel: string }>} the settled answer.
   */
  function withTimeout(promise, signal) {
    const racing = new Promise((resolves) => {
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        lifetime.signal.removeEventListener('abort', onLifetimeAbort)
        active.delete(racing)
        resolves(value)
      }
      const timer = timeoutMs > 0
        ? setTimeout(() => { finish({ outcome: 'unavailable', channel: 'timeout' }) }, timeoutMs)
        : undefined
      const onAbort = () => { finish({ outcome: 'unavailable', channel: 'aborted' }) }
      const onLifetimeAbort = () => { finish({ outcome: 'unavailable', channel: 'disposed' }) }
      signal?.addEventListener('abort', onAbort, { once: true })
      lifetime.signal.addEventListener('abort', onLifetimeAbort, { once: true })
      Promise.resolve(promise).then(finish, (error) => {
        logger?.warn?.(`dsh-peak-guard: confirmation failed: ${describe(error)}`)
        finish({ outcome: 'unavailable', channel: 'error' })
      })
    })
    active.add(racing)
    return racing
  }

  /**
   * The gate: an async generator that decides before delegating.
   *
   * The listener itself must stay synchronous, so all waiting happens inside
   * the returned iterable. Not calling `next()` is what vetoes provider
   * dispatch, and therefore what makes a refusal free.
   * @param {object} options - the intercepted `GenerateOptions`.
   * @param {() => AsyncIterable<object>} next - the downstream stream factory.
   * @returns {AsyncIterable<object>} the chunk stream.
   */
  function guard(options, next) {
    return (async function* guarded() {
      options.signal?.throwIfAborted()
      // The sidebar switch is consulted per call, so disabling the guard takes
      // effect on the next model call without reloading the plugin.
      if (!runtimeEnabled) {
        yield* next()
        return
      }
      const call = { provider: options.provider, model: options.model, purpose: options.purpose }
      const now = new Date()
      const decision = decide({ now, config, call })
      if (!decision.matched) {
        yield* next()
        return
      }

      const agent = options.sessionId === undefined ? undefined : ctx.agents.get(options.sessionId)
      const route = `${call.provider}/${call.model}`
      const when = `${decision.window.localTime} ${decision.window.weekday} ${decision.window.timeZone}`

      if (decision.action === 'allow') {
        const text = `[dsh-peak-guard] 空闲时段调用 ${route}（${when}），按空闲价计费。`
        if (decision.reason === 'off-peak' && config.notifyOffPeak) notify(agent, text, `空闲时段：${route}`)
        else logger?.info?.(`dsh-peak-guard: off-peak call to ${route} at ${when}`)
        yield* next()
        return
      }

      // ── peak: this call needs a human decision ──────────────────────────────
      if (config.localAgentsOnly && agent !== undefined && !ctx.agents.roots().includes(agent)) {
        logger?.info?.(`dsh-peak-guard: peak call to ${route} from subagent ${agent.id} allowed without asking`)
        yield* next()
        return
      }
      const windowKey = decisionWindowKey(now, decision)
      const remembered = agent === undefined ? undefined : readMemo(agent, call, windowKey)
      if (remembered === 'approved') {
        logger?.info?.(`dsh-peak-guard: peak call to ${route} reuses this window's approval`)
        yield* next()
        return
      }
      if (remembered === 'declined') {
        // Restate the wait AND the two ways out: a refusal the user cannot act
        // on is just a wall. The window is still the same one they declined.
        yield declined(
          `本次调用已在当前高峰时段（${when}）被拒绝过。${offPeakHint(decision)}`
          + '如需现在调用，可在左侧边栏关闭「峰谷计费守卫」，或调整插件配置。',
        )
        return
      }

      let answer = { outcome: 'unavailable', channel: 'none' }
      if (agent !== undefined) {
        answer = await withTimeout(askHuman(agent, call, decision, options.signal), options.signal)
      }
      options.signal?.throwIfAborted()

      if (answer.outcome === 'approved') {
        if (agent !== undefined) writeMemo(agent, call, windowKey, 'approved')
        logger?.info?.(`dsh-peak-guard: peak call to ${route} confirmed via ${answer.channel}`)
        notify(agent, `[dsh-peak-guard] 已在高峰时段（${when}）确认调用 ${route}。`, `高峰时段已确认：${route}`)
        yield* next()
        return
      }
      if (answer.outcome === 'declined') {
        if (agent !== undefined) writeMemo(agent, call, windowKey, 'declined')
        logger?.info?.(`dsh-peak-guard: peak call to ${route} declined via ${answer.channel}`)
        yield declined(
          `本次调用处于高峰时段（${when}），已按你的选择中止。${offPeakHint(decision)}`
          + '如需现在调用，可在左侧边栏关闭「峰谷计费守卫」，或调整插件配置。',
        )
        return
      }

      // ── nobody could answer ────────────────────────────────────────────────
      if (config.unaskableAction === 'block') {
        logger?.warn?.(`dsh-peak-guard: peak call to ${route} blocked: no confirmation channel (${answer.channel})`)
        yield declined(`本次调用处于高峰时段（${when}），但当前会话没有可用的确认通道（unaskableAction: block），已中止。`)
        return
      }
      logger?.warn?.(`dsh-peak-guard: peak call to ${route} allowed without confirmation: ${answer.channel}`)
      notify(
        agent,
        `[dsh-peak-guard] 无法发出确认请求（${answer.channel}），已按 unaskableAction: proceed 继续调用 ${route}（高峰价，${when}）。`,
        `高峰时段未能确认：${route}`,
      )
      yield* next()
    })()
  }

  const dispose = ctx.on('llm/stream', (options, next) => {
    // A waterfall may have captured this callback before disposal; a stale
    // callback must not start a new confirmation after the plugin is gone.
    if (lifetime.signal.aborted) return next()
    return guard(options, next)
  }, { prepend: true })

  ctx.effect(() => async () => {
    dispose()
    lifetime.abort(new Error('dsh-peak-guard plugin disposed'))
    await Promise.allSettled([...active])
    memo.clear()
    sharedMemo.clear()
  }, 'dsh-peak-guard: abort and drain pending confirmations')

  logger?.info?.(
    `dsh-peak-guard: installed ${runtimeEnabled ? 'enabled' : 'disabled'} (peak ${config.peakWindows
      .map(window => `${window.start}-${window.end}${window.weekdaysOnly === true ? ' weekdays' : ''}`)
      .join(', ')} ${config.timeZone}; providers ${config.providerPatterns.join(', ')}; `
    + `models ${config.modelPatterns.join(', ')}; switch ${STATE_ROUTE})`,
  )
}

/**
 * Validate the optional confirmation timeout.
 * @param {unknown} value - the raw `askTimeoutMs`.
 * @returns {number} a non-negative millisecond budget.
 * @throws {TypeError} when the value is not a non-negative finite number.
 */
function normalizeTimeout(value) {
  if (value === undefined) return DEFAULT_ASK_TIMEOUT_MS
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError('dsh-peak-guard: askTimeoutMs must be a non-negative finite number')
  }
  return value
}

/**
 * Render an unknown thrown value for a log line.
 * @param {unknown} error - the thrown value.
 * @returns {string} its message, or its string form.
 */
function describe(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  try {
    return String(error)
  } catch {
    return 'unprintable error'
  }
}

/**
 * Render a user-questions answer for a log line without risking a throw on a
 * circular or hostile value.
 * @param {unknown} answer - whatever the answerer returned.
 * @returns {string} a bounded description.
 */
function describeAnswer(answer) {
  try {
    const text = JSON.stringify(answer)
    if (text === undefined) return String(answer)
    return text.length > 300 ? `${text.slice(0, 300)}…` : text
  } catch {
    return 'unserializable answer'
  }
}
