/**
 * Deterministic tests for the Cordis-facing gate: the `llm/stream` listener,
 * the confirmation waterfall (approval -> user-questions -> unaskable policy),
 * the refusal chunk, and the repeat-ask memo.
 *
 * A fake context supplies just the surface the plugin touches, so no Cordis
 * application is booted and no provider is ever reached. The peak window is
 * anchored to the current hour (see {@link alwaysPeak}) so the assertions hold
 * whenever the suite runs.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply, DECLINED_CODE, inject as declaredInject, name as pluginName } from '../index.js'
import { zonedFields } from '../src/peak.js'

/**
 * A window that certainly covers the wall clock right now.
 *
 * A fixed `00:00–23:59` window looks like "always" but is not: `end` is
 * exclusive, so the final minute of the day falls outside it and the fixture
 * silently stops working for one minute in every 1440. Anchoring the window to
 * the current hour keeps every assertion below independent of when the suite
 * runs, without depending on that off-by-one-minute edge.
 *
 * @returns {object[]} a peak window covering the current hour.
 */
function alwaysPeak() {
  const { hour } = zonedFields(new Date(), 'Asia/Shanghai')
  if (hour === 23) {
    // A wrapping window covers 23:00 through 00:59 without the exclusive-end
    // edge: the guard is only asserted on the 23:00–23:59 side.
    return [{ start: '23:00', end: '01:00' }]
  }
  return [{ start: `${String(hour).padStart(2, '0')}:00`, end: `${String(hour + 1).padStart(2, '0')}:00` }]
}

/** Collect the chunks an intercepted stream produces. */
async function drain(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** Notices delivered through `agent.inject`, reset per harness construction. */
let notices = []

/** A downstream stream that records that provider dispatch was reached. */
function downstream(seen) {
  seen.dispatched = true
  return (async function* real() {
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

/**
 * Build the fake Cordis context and install the plugin on it.
 *
 * @param {object} [options] - test overrides.
 * @param {object} [options.config] - plugin config overrides.
 * @param {object} [options.agent] - the agent `ctx.agents.get` returns.
 * @param {boolean} [options.isRoot] - whether `ctx.agents.roots()` lists that agent.
 * @param {object} [options.approval] - an `ctx.approval` stub, or undefined for none.
 * @param {object} [options.questions] - a `ctx.userQuestions` stub, or undefined for none.
 * @param {number} [options.timeoutMs] - the confirmation budget; 0 disables the timer.
 * @returns {{ ctx: object, call: Function, dispose: Function | undefined, warnings: string[], notices: object[] }} the harness.
 */
function harness(options = {}) {
  const agent = options.agent ?? {
    id: 'session-1',
    session: { id: 'session-1' },
    inject: (message) => { notices.push(message) },
  }
  const warnings = []
  const listeners = new Map()
  const effectDisposers = []
  // Every harness owns a private switch file. Without this the plugin would read
  // the REAL `.peak-guard-state.json` beside the package — which records whatever
  // the sidebar switch was last left at — and a disabled switch would silently
  // turn every assertion below into a pass-through, testing nothing.
  const stateDir = mkdtempSync(join(tmpdir(), 'peak-guard-gate-'))
  const statePath = join(stateDir, 'state.json')
  const ctx = {
    logger: {
      info: () => {},
      debug: () => {},
      warn: (message) => warnings.push(String(message)),
    },
    get: (key) => (key === 'approval' ? options.approval : key === 'userQuestions' ? options.questions : undefined),
    agents: {
      get: (id) => (id === agent.id ? agent : undefined),
      roots: () => (options.isRoot === false ? [] : [agent]),
    },
    on: (event, listener) => {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    // Collect every effect disposer: the plugin registers more than one (the
    // stream listener, and the sidebar route's mount).
    effect: (factory) => {
      const result = factory()
      if (typeof result === 'function') effectDisposers.push(result)
    },
    // No web server in this harness, so the route mount never runs — which is
    // the headless composition these gate tests model.
    inject: () => ({ dispose: () => {} }),
  }
  apply(ctx, {
    peakWindows: alwaysPeak(),
    // The notice path is exercised separately; the assertions here care about
    // the stream, so the timer stays disabled unless a test asks for one.
    askTimeoutMs: options.timeoutMs ?? 0,
    statePath,
    ...options.config,
  })
  return {
    ctx,
    warnings,
    notices,
    statePath,
    /** Run every registered effect disposer, as a fiber unload would. */
    dispose: async () => {
      for (const disposer of effectDisposers.splice(0)) await disposer()
      rmSync(stateDir, { recursive: true, force: true })
    },
    /** Invoke the registered listener the way the LLM service would. */
    call: (request, seen = {}) => listeners.get('llm/stream')(request, () => downstream(seen)),
  }
}

/** Reset the shared notice sink before each harness construction. */
function resetNotices() {
  notices = []
}

const REQUEST = { provider: 'deepseek-official', model: 'deepseek-flash', sessionId: 'session-1' }

test('apply declares its identity and required services', () => {
  assert.equal(pluginName, 'dsh-peak-guard')
  assert.deepEqual(declaredInject, ['llm', 'agents'])
})

test('an off-peak call passes straight through', async () => {
  resetNotices()
  const h = harness({ config: { peakWindows: [{ start: '03:00', end: '04:00' }] } })
  const seen = {}
  const chunks = await drain(h.call(REQUEST, seen))
  assert.equal(seen.dispatched, true, 'the downstream stream must be reached')
  assert.deepEqual(chunks, [{ type: 'finish', reason: { kind: 'stop' } }])
})

test('a non-target provider passes straight through', async () => {
  resetNotices()
  const h = harness()
  const seen = {}
  await drain(h.call({ provider: 'anthropic', model: 'claude', sessionId: 'session-1' }, seen))
  assert.equal(seen.dispatched, true)
})

test('an auxiliary call is not gated by default', async () => {
  resetNotices()
  const h = harness()
  const seen = {}
  await drain(h.call({ ...REQUEST, purpose: 'session-title' }, seen))
  assert.equal(seen.dispatched, true)
})

test('a peak call approved through the approval seam is dispatched', async () => {
  resetNotices()
  const asked = []
  const h = harness({
    approval: {
      effectivePolicy: () => 'ask',
      request: async (request) => {
        asked.push(request)
        return 'allowed-once'
      },
    },
  })
  const seen = {}
  const chunks = await drain(h.call(REQUEST, seen))
  assert.equal(seen.dispatched, true)
  assert.deepEqual(chunks, [{ type: 'finish', reason: { kind: 'stop' } }])
  assert.equal(asked.length, 1, 'exactly one approval question')
  assert.equal(asked[0].agent.id, 'session-1')
  assert.equal(asked[0].toolName, 'llm.call')
  assert.match(asked[0].reason, /高峰/)
})

test('the never approval policy is skipped in favour of user-questions', async () => {
  resetNotices()
  let approvalAsked = false
  const questions = []
  const h = harness({
    approval: {
      effectivePolicy: () => 'never',
      request: async () => {
        approvalAsked = true
        return 'rejected'
      },
    },
    questions: {
      ask: async (request) => {
        questions.push(request)
        return { answers: [{ id: 'dsh-peak-guard', selected: ['确认调用'] }] }
      },
    },
  })
  const seen = {}
  await drain(h.call(REQUEST, seen))
  assert.equal(approvalAsked, false, 'a never policy must not burn an audit pair')
  assert.equal(questions.length, 1)
  assert.deepEqual(questions[0].questions[0].options.map(option => option.label), ['确认调用', '稍后重试'])
  assert.equal(seen.dispatched, true)
})

test('the earlier user-questions answer shape is understood too', async () => {
  resetNotices()
  const h = harness({
    questions: { ask: async () => ({ selected: ['确认调用'] }) },
  })
  const seen = {}
  await drain(h.call(REQUEST, seen))
  assert.equal(seen.dispatched, true)
})

test('a declined call yields a terminal refusal and never dispatches', async () => {
  resetNotices()
  const h = harness({
    questions: { ask: async () => ({ answers: [{ id: 'dsh-peak-guard', selected: ['稍后重试'] }] }) },
  })
  const seen = {}
  const chunks = await drain(h.call(REQUEST, seen))
  assert.equal(seen.dispatched, undefined, 'provider dispatch must be vetoed')
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].type, 'finish')
  assert.equal(chunks[0].reason.kind, 'error')
  assert.equal(chunks[0].reason.failure.code, DECLINED_CODE)
  assert.match(chunks[0].reason.failure.message, /高峰时段/)
})

test('an approval-implemented rejection is a refusal', async () => {
  resetNotices()
  const h = harness({
    approval: { effectivePolicy: () => 'ask', request: async () => 'rejected' },
  })
  const seen = {}
  const chunks = await drain(h.call(REQUEST, seen))
  assert.equal(seen.dispatched, undefined)
  assert.equal(chunks[0].reason.failure.code, DECLINED_CODE)
})

test('unaskableAction proceed dispatches and warns', async () => {
  resetNotices()
  const h = harness()
  const seen = {}
  await drain(h.call(REQUEST, seen))
  assert.equal(seen.dispatched, true)
  assert.equal(h.warnings.length, 1)
  assert.match(h.warnings[0], /allowed without confirmation/)
})

test('unaskableAction block refuses when nobody can answer', async () => {
  resetNotices()
  const h = harness({ config: { unaskableAction: 'block' } })
  const seen = {}
  const chunks = await drain(h.call(REQUEST, seen))
  assert.equal(seen.dispatched, undefined)
  assert.equal(chunks[0].reason.failure.code, DECLINED_CODE)
  assert.match(chunks[0].reason.failure.message, /没有可用的确认通道/)
})

test('a throwing confirmation channel degrades to the unaskable policy', async () => {
  resetNotices()
  const h = harness({
    questions: { ask: async () => { throw new Error('transport died') } },
  })
  const seen = {}
  await drain(h.call(REQUEST, seen))
  assert.equal(seen.dispatched, true)
  assert.equal(h.warnings.some(line => /user-questions channel unavailable/.test(line)), true)
})

test('a subagent call is allowed without asking by default', async () => {
  resetNotices()
  let asked = false
  const h = harness({
    isRoot: false,
    questions: { ask: async () => { asked = true; return { selected: ['稍后重试'] } } },
  })
  const seen = {}
  await drain(h.call(REQUEST, seen))
  assert.equal(asked, false)
  assert.equal(seen.dispatched, true)
})

test('localAgentsOnly false gates subagents too', async () => {
  resetNotices()
  let asked = false
  const h = harness({
    isRoot: false,
    config: { localAgentsOnly: false },
    questions: { ask: async () => { asked = true; return { selected: ['确认调用'] } } },
  })
  const seen = {}
  await drain(h.call(REQUEST, seen))
  assert.equal(asked, true)
  assert.equal(seen.dispatched, true)
})

test('a repeated call inside one window reuses the decision', async () => {
  resetNotices()
  let asked = 0
  const options = {
    approval: { effectivePolicy: () => 'ask', request: async () => { asked += 1; return 'rejected' } },
  }
  const first = harness(options)
  const chunks = await drain(first.call(REQUEST, {}))
  assert.equal(chunks[0].reason.failure.code, DECLINED_CODE)
  assert.equal(asked, 1)

  // A fresh install reuses nothing; the memo is per plugin instance, so the
  // second harness must ask again rather than inherit the first one's answer.
  resetNotices()
  const second = harness(options)
  const again = await drain(second.call(REQUEST, {}))
  assert.equal(again[0].reason.failure.code, DECLINED_CODE)
  assert.equal(asked, 2)
})

test('suppressRepeatAsks false asks every time', async () => {
  resetNotices()
  let asked = 0
  const h = harness({
    config: { suppressRepeatAsks: false },
    questions: { ask: async () => { asked += 1; return { selected: ['确认调用'] } } },
  })
  await drain(h.call(REQUEST, {}))
  await drain(h.call(REQUEST, {}))
  assert.equal(asked, 2)
})

test('a call whose session has no live agent still dispatches under proceed', async () => {
  resetNotices()
  const h = harness()
  const seen = {}
  await drain(h.call({ provider: 'deepseek-official', model: 'deepseek-flash', sessionId: 'gone' }, seen))
  assert.equal(seen.dispatched, true)
})

test('the request signal is honoured before any I/O', async () => {
  resetNotices()
  const h = harness()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => drain(h.call({ ...REQUEST, signal: controller.signal }, {})),
    /abort/i,
  )
})

test('disposal unregisters the listener and drains a pending confirmation', async () => {
  resetNotices()
  const h = harness({
    timeoutMs: 60,
    questions: { ask: () => new Promise(() => {}) },
  })
  assert.equal(typeof h.dispose, 'function')
  const pending = drain(h.call(REQUEST, {}))
  await h.dispose()
  // The confirmation never resolves, so the unaskable policy decides the
  // outcome; the point of the assertion is that disposal did not deadlock it.
  const chunks = await pending
  assert.equal(chunks[0].reason.kind, 'stop')
  assert.equal(h.warnings.some(line => /allowed without confirmation/.test(line)), true)
})

test('a malformed config fails the plugin loudly at load', () => {
  const ctx = {
    logger: { info: () => {}, debug: () => {}, warn: () => {} },
    get: () => undefined,
    agents: { get: () => undefined, roots: () => [] },
    on: () => () => {},
    effect: () => {},
  }
  assert.throws(() => apply(ctx, { peakWindows: 'tomorrow' }), /peakWindows/)
  assert.throws(() => apply(ctx, { askTimeoutMs: -1 }), /askTimeoutMs/)
})
