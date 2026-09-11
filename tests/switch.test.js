/**
 * Tests for the sidebar switch's host half: the persisted runtime state, the
 * JSON route the browser drives, and the gate's obedience to the switch.
 *
 * A fake context supplies just the surface `apply` touches, so no Cordis
 * application and no web server are booted.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply, readRuntimeState, writeRuntimeState } from '../index.js'

/** A window covering every instant, so the gate always classifies as peak. */
const ALWAYS_PEAK = [{ start: '00:00', end: '23:59' }]

/** Create an isolated state-file path for one test. */
function tempStatePath(name) {
  const dir = mkdtempSync(join(tmpdir(), `peak-guard-${name}-`))
  return { path: join(dir, 'state.json'), cleanup: () => { rmSync(dir, { recursive: true, force: true }) } }
}

/**
 * A response recorder standing in for `ServerResponse`.
 * @returns {object} the response double plus a reader for what was written.
 */
function fakeResponse() {
  const state = { status: undefined, headers: undefined, body: '' }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers
    },
    end(chunk) {
      state.body = chunk === undefined ? '' : String(chunk)
    },
    setHeader() {},
    /** Parse the recorded body. */
    json() {
      return JSON.parse(state.body)
    },
  }
}

/**
 * A fake Cordis context capturing the registered state route.
 * @param {object} [options] - test overrides.
 * @param {string} [options.statePath] - where the switch persists.
 * @param {boolean} [options.withServer] - whether `ctx.get('webServer')` answers.
 * @returns {object} the harness.
 */
function harness(options = {}) {
  const routes = new Map()
  const warnings = []
  const agent = {
    id: 'session-1',
    session: { id: 'session-1' },
    inject: () => {},
  }
  const webServer = options.withServer === false ? undefined : {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
  const listeners = new Map()
  const ctx = {
    logger: { info: () => {}, debug: () => {}, warn: (m) => warnings.push(String(m)) },
    get: (key) => (key === 'webServer' ? webServer : undefined),
    agents: { get: (id) => (id === agent.id ? agent : undefined), roots: () => [agent] },
    on: (event, listener) => {
      listeners.set(event, listener)
      return () => listeners.delete(event)
    },
    // Real cordis runs the effect body immediately and then runs whatever
    // disposers it returned on unload. The mount's disposer is the route
    // remover, so a no-op collector reproduces the load half faithfully.
    effect: (factory) => { factory() },
    // The route waits for `webServer` through `ctx.inject`; with the service
    // present the callback runs immediately, and with it absent it never runs —
    // which is exactly the headless case under test.
    inject: (deps, callback) => {
      if (deps.includes('webServer') && webServer !== undefined) callback(ctx)
      return { dispose: () => {} }
    },
  }
  apply(ctx, {
    peakWindows: ALWAYS_PEAK,
    askTimeoutMs: 0,
    ...(options.statePath === undefined ? {} : { statePath: options.statePath }),
  })
  return {
    routes,
    warnings,
    /** Invoke the registered route handler. */
    route: (req) => {
      const handler = routes.get('/api/peak-guard/state')
      assert.ok(handler, 'the state route is registered')
      const res = fakeResponse()
      return handler.handler(req, res).then(() => res)
    },
    /** Whether a model call at peak reaches provider dispatch. */
    dispatchReached: async () => {
      const seen = {}
      const listener = listeners.get('llm/stream')
      const stream = listener(
        { provider: 'deepseek-official', model: 'deepseek-flash', sessionId: 'session-1' },
        () => {
          seen.dispatched = true
          return (async function* real() { yield { type: 'finish', reason: { kind: 'stop' } } })()
        },
      )
      for await (const _chunk of stream) { /* drain */ }
      return seen.dispatched === true
    },
  }
}

test('a missing state file means the switch was never set', () => {
  const { path, cleanup } = tempStatePath('missing')
  try {
    assert.equal(readRuntimeState(path), undefined)
  } finally {
    cleanup()
  }
})

test('the state file round-trips a boolean', () => {
  const { path, cleanup } = tempStatePath('roundtrip')
  try {
    writeRuntimeState(path, false)
    assert.equal(readRuntimeState(path), false)
    writeRuntimeState(path, true)
    assert.equal(readRuntimeState(path), true)
  } finally {
    cleanup()
  }
})

test('a malformed state file is ignored rather than fatal', () => {
  const { path, cleanup } = tempStatePath('malformed')
  try {
    writeFileSync(path, '{ not json')
    assert.equal(readRuntimeState(path), undefined)
    writeFileSync(path, JSON.stringify({ enabled: 'yes' }))
    assert.equal(readRuntimeState(path), undefined)
    writeFileSync(path, JSON.stringify(['enabled']))
    assert.equal(readRuntimeState(path), undefined)
  } finally {
    cleanup()
  }
})

test('GET reports the switch, the standing, and the peak windows', async () => {
  const { path, cleanup } = tempStatePath('get')
  try {
    const h = harness({ statePath: path })
    const res = await h.route({ method: 'GET' })
    assert.equal(res.state.status, 200)
    assert.equal(res.state.headers['cache-control'], 'no-store')
    const body = res.json()
    assert.equal(body.ok, true)
    assert.equal(body.name, 'dsh-peak-guard')
    assert.equal(body.enabled, true, 'a fresh install follows the configured default')
    assert.equal(body.peak, true, 'the whole-day window classifies as peak')
    assert.equal(typeof body.localTime, 'string')
    assert.equal(body.timeZone, 'Asia/Shanghai')
    assert.equal(body.peakWindows.length, 1)
    assert.equal('enabled' in body, true)
  } finally {
    cleanup()
  }
})

test('POST persists the switch and answers with the new snapshot', async () => {
  const { path, cleanup } = tempStatePath('post')
  try {
    const h = harness({ statePath: path })
    const res = await h.route({ method: 'POST', body: JSON.stringify({ enabled: false }) })
    assert.equal(res.state.status, 200)
    assert.equal(res.json().enabled, false)
    assert.equal(res.json().persisted, true)
    assert.equal(readRuntimeState(path), false, 'the switch survives a restart')
  } finally {
    cleanup()
  }
})

test('POST rejects a body that is not a boolean', async () => {
  const { path, cleanup } = tempStatePath('bad-body')
  try {
    const h = harness({ statePath: path })
    // An empty body, a non-JSON body, a non-boolean field, and a missing field
    // must each fail fast with 400 — never a silent write.
    for (const body of ['', 'nope', JSON.stringify({ enabled: 'yes' }), JSON.stringify({})]) {
      const res = await h.route({ method: 'POST', body })
      assert.equal(res.state.status, 400, `body ${JSON.stringify(body)} must be rejected`)
      assert.equal(res.json().ok, false)
    }
    assert.equal(existsSync(path), false, 'a rejected write leaves no state file')
  } finally {
    cleanup()
  }
})

test('the route refuses an unsupported method', async () => {
  const { path, cleanup } = tempStatePath('method')
  try {
    const h = harness({ statePath: path })
    const res = await h.route({ method: 'DELETE' })
    assert.equal(res.state.status, 405)
  } finally {
    cleanup()
  }
})

test('the gate is bypassed once the switch is off, and restored when on', async () => {
  const { path, cleanup } = tempStatePath('gate')
  try {
    // Start disabled through the persisted switch: the file is read at apply.
    writeRuntimeState(path, false)
    const h = harness({ statePath: path })
    assert.equal(await h.dispatchReached(), true, 'a disabled guard lets calls through')

    await h.route({ method: 'POST', body: JSON.stringify({ enabled: true }) })
    // With the switch back on, a peak call without an answerer follows
    // unaskableAction: proceed, so it still dispatches — but it now consults the
    // gate, which is what the warning records.
    await h.dispatchReached()
    assert.equal(
      h.warnings.some(line => /allowed without confirmation/.test(line)),
      true,
      'the re-enabled guard consulted its confirmation path',
    )
  } finally {
    cleanup()
  }
})

test('a composition without a web server still loads', () => {
  const h = harness({ withServer: false })
  assert.equal(h.routes.size, 0)
  assert.equal(h.warnings.length, 0, 'the absence of a server is not a warning')
})

test('the boot report proves whether the route mounted', () => {
  // This file is the outside-the-process answer to "the sidebar says it cannot
  // read the state": it separates a stale module from a failed mount.
  const ok = tempStatePath('boot-ok')
  try {
    harness({ statePath: ok.path })
    const report = JSON.parse(readFileSync(`${ok.path}.boot.json`, 'utf8'))
    assert.equal(report.mounted, true)
    assert.equal(report.route, '/api/peak-guard/state')
    assert.equal(typeof report.at, 'string')
  } finally {
    ok.cleanup()
  }

  // A headless composition never receives the service, so the mount callback
  // never runs and no report is written — the absence itself is the signal.
  const none = tempStatePath('boot-none')
  try {
    const h = harness({ statePath: none.path, withServer: false })
    assert.equal(h.routes.size, 0)
    assert.equal(existsSync(`${none.path}.boot.json`), false)
  } finally {
    none.cleanup()
  }
})

test('a snapshot reflects a persisted disable at load time', async () => {
  const { path, cleanup } = tempStatePath('persisted')
  try {
    writeRuntimeState(path, false)
    const h = harness({ statePath: path })
    const res = await h.route({ method: 'GET' })
    assert.equal(res.json().enabled, false)
    assert.equal(res.json().configuredEnabled, true, 'the config default is still reported')
    assert.equal(readFileSync(path, 'utf8').includes('false'), true)
  } finally {
    cleanup()
  }
})
