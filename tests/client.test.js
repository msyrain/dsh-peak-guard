/**
 * Tests for the browser half.
 *
 * The client artifact is a closure-factory script: it calls
 * `window.__ModuleLoader__.load({ id, factory })` and its factory receives the
 * module-table `require`. This suite reconstructs that contract in Node, hands
 * the factory a small module table (`react`, `react-dom/server`), and then:
 *
 * 1. registers the bundle through `apply` into a fake slot registry, and
 * 2. statically renders the registered component with an effect-flushing
 *    `renderToStaticMarkup` stub.
 *
 * That is enough to catch the failures a browser would otherwise hide: a wrong
 * registration seat, a missing export, a require outside the platform module
 * table, or a render that throws on a real host snapshot.
 *
 * Run with `node --test "tests/*.test.js"`.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ARTIFACT = join(ROOT, 'lib', 'client.js')
const PACKAGE_NAME = 'dsh-peak-guard'

/** A host snapshot shaped exactly like the `/api/peak-guard/state` body. */
const SNAPSHOT = {
  ok: true,
  name: PACKAGE_NAME,
  displayName: '峰谷计费守卫',
  enabled: true,
  configuredEnabled: true,
  peak: true,
  offPeak: false,
  localTime: '10:24',
  weekday: 'Thu',
  timeZone: 'Asia/Shanghai',
  peakWindows: [
    { start: '09:00', end: '12:00', weekdaysOnly: true, label: '上午高峰' },
    { start: '14:00', end: '18:00', weekdaysOnly: true, label: '下午高峰' },
  ],
}

/**
 * Build the module table the factory requires, plus the DOM and fetch stubs the
 * component touches.
 * @param {object} [options] - test overrides.
 * @param {object | null} [options.snapshot] - the JSON the fake fetch returns.
 * @returns {{ modules: Map<string, unknown>, styles: object[], fetches: object[] }} the harness pieces.
 */
function moduleTable(options = {}) {
  const styles = []
  const fetches = []
  let cursor = 0
  let pendingEffects = []
  let hooks = []

  const react = {
    useState(initial) {
      const slot = cursor
      cursor += 1
      if (hooks[slot] === undefined) hooks[slot] = initial
      return [hooks[slot], (next) => { hooks[slot] = next }]
    },
    useCallback(fn) {
      return fn
    },
    useEffect(fn) {
      pendingEffects.push(fn)
    },
    createElement(type, props, ...children) {
      return {
        type,
        props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children },
      }
    },
  }

  const render = (element) => {
    if (element === null || element === undefined || element === false) return ''
    if (typeof element === 'string' || typeof element === 'number') return String(element)
    if (Array.isArray(element)) return element.map(render).join('')
    if (typeof element.type === 'function') return render(element.type(element.props))
    const { children, ...attributes } = element.props
    const attrs = Object.entries(attributes)
      .filter(([key]) => key !== 'onClick' && key !== 'title')
      .map(([key, value]) => ` ${key}="${String(value)}"`)
      .join('')
    return `<${element.type}${attrs}>${render(children)}</${element.type}>`
  }

  const renderToStaticMarkup = async (element) => {
    // Prime the component once so its effects queue, run them the way a browser
    // commit would, let the awaited fetch settle and commit, then render the
    // SAME element so the assertions see the snapshot rather than initial state.
    cursor = 0
    hooks = []
    element.type(element.props)
    const cleanups = []
    for (const effect of pendingEffects) {
      const cleanup = effect()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    }
    pendingEffects = []
    // Let the mount fetch settle and commit. A fixed tick count is brittle, so
    // drain a generous run of microtasks instead.
    for (let tick = 0; tick < 20; tick += 1) await Promise.resolve()
    cursor = 0
    const html = render(element)
    for (const cleanup of cleanups) cleanup()
    return html
  }

  const modules = new Map([
    ['react', react],
    ['react-dom/server', { renderToStaticMarkup }],
  ])

  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, remove() {} }),
    head: { appendChild: (tag) => styles.push(tag) },
  }
  globalThis.window = { setInterval: () => 0, clearInterval: () => {} }
  globalThis.fetch = async (url, init) => {
    fetches.push({ url, init })
    const body = options.snapshot === undefined ? SNAPSHOT : options.snapshot
    return { ok: body !== null, json: async () => body }
  }

  return { modules, styles, fetches }
}

/**
 * Load the built artifact and return its exports plus the registration it made.
 * @param {object} table - the module table from {@link moduleTable}.
 * @returns {{ exports: object, registration: object }} the materialized bundle.
 */
function loadBundle(table) {
  const source = readFileSync(ARTIFACT, 'utf8')
  let registration
  globalThis.window.__ModuleLoader__ = {
    load: (value) => { registration = value },
  }
  const factory = new Function('window', 'require', source)
  const requireFrom = (specifier) => {
    if (!table.modules.has(specifier)) throw new Error(`unexpected require("${specifier}")`)
    return table.modules.get(specifier)
  }
  factory(globalThis.window, requireFrom)
  return { registration, exports: registration.factory(requireFrom) }
}

/**
 * A client context recording slot registrations and running effect factories.
 * @returns {{ ctx: object, registrations: object[], effectCleanups: Function[] }} the fake context.
 */
function fakeClientContext() {
  const registrations = []
  const effectCleanups = []
  const ctx = {
    effect(factory) {
      const cleanup = factory()
      if (typeof cleanup === 'function') effectCleanups.push(cleanup)
      return () => {}
    },
    slots: {
      inject(seat, callback) {
        assert.equal(seat, 'sidebar.footer.action')
        callback()
        return () => {}
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  return { ctx, registrations, effectCleanups }
}

/**
 * Apply the bundle and render its registered row.
 * @param {object} table - the module table.
 * @param {object} rowProps - props for the registered component.
 * @returns {Promise<{ html: string, registrations: object[], table: object }>} the rendered markup.
 */
async function renderRow(table, rowProps) {
  const { exports } = loadBundle(table)
  const { ctx, registrations } = fakeClientContext()
  exports.apply(ctx)
  const [{ component }] = registrations
  const element = table.modules.get('react').createElement(component, rowProps)
  return {
    html: await table.modules.get('react-dom/server').renderToStaticMarkup(element),
    registrations,
    table,
  }
}

test('the built artifact registers under the package name', () => {
  const table = moduleTable()
  const { registration } = loadBundle(table)
  assert.equal(registration.id, PACKAGE_NAME, 'the graph row is keyed by the package name')
  assert.equal(typeof registration.factory, 'function')
})

test('the artifact exports the client plugin contract', () => {
  const { exports } = loadBundle(moduleTable())
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots', 'locale'])
})

test('apply registers one row at the footer action seat above Settings', async () => {
  const { registrations } = await renderRow(moduleTable(), { wide: true })
  assert.equal(registrations.length, 1)
  const [{ options, component }] = registrations
  assert.equal(options.name, 'sidebar.footer.action')
  assert.equal(options.id, 'peak-guard')
  assert.equal(typeof options.inject, 'function')
  assert.equal(typeof component, 'function')
  // The footer action seat is a horizontal flex row shared with the shipped
  // updater row. The stylesheet turns it into a wrapping container and this
  // negative order is what claims the first line, so the row sits ABOVE the
  // updater row instead of beside it.
  assert.equal(options.order, -1)
})

test('apply injects its stylesheet exactly once', () => {
  const table = moduleTable()
  const { exports } = loadBundle(table)
  const { ctx, effectCleanups } = fakeClientContext()
  exports.apply(ctx)
  assert.equal(table.styles.length, 1)
  const [tag] = table.styles
  assert.equal(tag.dataset.plugin, PACKAGE_NAME)
  assert.equal(tag.dataset.pluginCss, `${PACKAGE_NAME}/sidebar.css`)
  assert.match(tag.textContent, /\.peak-guard-row/)
  assert.match(tag.textContent, /width:100%/, 'the row claims a full line')
  // Without border-box the full-line width EXCLUDES the padding, so the row
  // overflows its container and clips both edges — the exact bug this guards.
  assert.match(tag.textContent, /box-sizing:border-box/)
  // The layout anchor: the footer seat must wrap for a full-width row to stack
  // instead of being forced beside the shipped updater row.
  assert.match(tag.textContent, /\[class\*="footerActions"\]/)
  assert.match(tag.textContent, /flex-wrap:wrap/)
  // Defence in depth: the container re-asserts border-box on this row, so a
  // lost row-level rule still cannot clip it.
  assert.match(tag.textContent, /\[class\*="footerActions"\] > \.peak-guard-row\{box-sizing:border-box/)
  assert.equal(effectCleanups.length, 1, 'the style tag has a disposer')
})

test('the row renders the name, the switch, and the live standing', async () => {
  const { html, table } = await renderRow(moduleTable(), { wide: true, t: (key) => key })
  assert.match(html, /峰谷计费守卫/, 'the plugin name is shown')
  assert.match(html, /peak-guard-track/, 'the switch is rendered')
  assert.match(html, /data-on="true"/, 'the switch reflects the host snapshot')
  assert.match(
    html,
    /10:24 高峰价 · 09:00-12:00、14:00-18:00/,
    'the clock, phase, and windows render together',
  )
  assert.equal(table.fetches.length >= 1, true)
  assert.equal(table.fetches[0].url, '/api/peak-guard/state')
})

test('the build stamp identifies the artifact and reaches the DOM', async () => {
  const source = readFileSync(ARTIFACT, 'utf8')
  assert.doesNotMatch(source, /__BUILD_STAMP__/, 'the build must replace the stamp placeholder')
  const stamped = /const BUILD_STAMP = '([^']+)'/.exec(source)
  assert.ok(stamped, 'the artifact carries a literal build stamp')
  // Content-derived, not a timestamp: a timestamp would change on every build
  // and make "is this artifact current?" unanswerable.
  assert.match(stamped[1], /^[0-9a-f]{12}$/)

  const { html } = await renderRow(moduleTable(), { wide: true, t: (key) => key })
  assert.match(html, new RegExp(`data-build="${stamped[1]}"`), 'the row exposes the stamp')
  assert.match(source, /console\.info\('\[dsh-peak-guard\] client build '/, 'and logs it once')
})

test('the rail form renders a dot instead of the full row', async () => {
  const { html } = await renderRow(moduleTable(), { wide: false, t: (key) => key })
  assert.match(html, /peak-guard-rail/)
  assert.match(html, /peak-guard-dot/)
  assert.doesNotMatch(html, /peak-guard-name/)
})

test('a disabled snapshot renders the off state', async () => {
  const { html } = await renderRow(
    moduleTable({ snapshot: { ...SNAPSHOT, enabled: false, peak: false } }),
    { wide: true, t: (key) => key },
  )
  assert.match(html, /data-on="false"/)
  assert.match(html, /已关闭：所有调用直接放行/)
})

test('an unreachable host renders a readable fallback', async () => {
  const { html } = await renderRow(moduleTable({ snapshot: null }), { wide: true, t: (key) => key })
  assert.match(html, /无法读取状态/)
})

test('the artifact requires nothing outside the platform module table', () => {
  const source = readFileSync(ARTIFACT, 'utf8')
  const required = [...source.matchAll(/require\((['"])([^'"]+)\1\)/g)].map(match => match[2])
  assert.deepEqual([...new Set(required)].sort(), ['react'])
})
