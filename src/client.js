/**
 * Browser half of the peak guard: the sidebar row above Settings that names the
 * plugin and carries its enable/disable switch.
 *
 * This file is BROWSER source, compiled by scripts/build-client.mjs into the
 * lib/client.js closure-factory artifact the DSH client module system fetches.
 * Two consequences shape the style below:
 *
 * - no JSX: the artifact must be reproducible without the monorepo's tsdown
 *   preset, so elements are built with React.createElement;
 * - no backticks or interpolation: the artifact stays a trivial, reviewable
 *   wrap of this file, so strings are concatenated and prose uses quotes.
 *
 * The switch itself lives in host memory, so the two halves talk over one
 * same-origin JSON route (/api/peak-guard/state) -- the same channel the
 * shipped updater panel uses.
 */

/** Registration id; must equal the package name the graph row is keyed by. */
const PLUGIN_ID = '__PLUGIN_ID__'

/**
 * React from the frozen module table. "require" is the closure factory's own
 * parameter (see scripts/build-client.mjs); this declaration is what the
 * artifact's factory body resolves.
 */
var React = require('react')

/** The host route that reads and writes the switch. */
const STATE_ROUTE = '/api/peak-guard/state'

/**
 * Build stamp, substituted by scripts/build-client.mjs at build time.
 *
 * It exists so "which revision is this page running?" is answerable without
 * guessing: the value is stamped onto the row as "data-build" and logged once
 * at activation, so a stale bundle is visible in the DOM instead of being
 * inferred from a rendering symptom.
 */
const BUILD_STAMP = '__BUILD_STAMP__'

/** Row label and tooltip subject. */
const LABEL = '峰谷计费守卫'

/** Inline styles, injected once at plugin activation. */
/**
 * Stylesheet. Injected once per page, and its two halves do different jobs:
 *
 * - the row's own chrome, scoped by the "peak-guard-" prefix; and
 * - one layout anchor. The sidebar footer seat (".footerActions") is a
 *   horizontal flex row with no wrap, so every registered action is forced
 *   beside the others instead of stacked. The bracketed selector matches that
 *   class by its stable trailing fragment and turns the container into a
 *   wrapping column, which is what lets this row take a full line ABOVE the
 *   shipped updater row instead of sharing one with it.
 *
 * If the sidebar's CSS-module hash ever changes, that anchor stops matching and
 * the row degrades to sitting beside the updater row — still functional, just
 * inline. Nothing else depends on it.
 */
const STYLE = [
  // box-sizing matters here: the row claims a full line, and under the default
  // content-box that width EXCLUDES the padding, so the row would overflow its
  // container by 20px and clip both edges. border-box is what keeps the row,
  // its padding, and the switch inside the sidebar column.
  '.peak-guard-row{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;min-width:0;padding:6px 10px;border-radius:8px;background:0 0;border:none;color:var(--theme-fg-1,#d8dee9);font:inherit;font-size:13px;line-height:1;cursor:pointer;overflow:hidden}',
  '.peak-guard-row:hover{background:var(--theme-bg-hover,#ffffff0f)}',
  '[class*="footerActions"]{display:flex;flex-wrap:wrap;align-items:center;row-gap:4px}',
  // Defence in depth for the same full-line requirement: even if the row's own
  // box-sizing rule were lost, the container re-asserts it here, so a
  // padding-induced overflow still cannot push the row past the sidebar edge.
  '[class*="footerActions"] > .peak-guard-row{box-sizing:border-box;max-width:100%}',
  '.peak-guard-rail{box-sizing:border-box;flex:0 0 auto;justify-content:center;width:40px;height:40px;padding:8px}',
  '.peak-guard-text{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto;text-align:left}',
  '.peak-guard-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.peak-guard-status{font-size:11px;color:var(--theme-fg-2,#9aa4b2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.peak-guard-track{position:relative;flex:none;width:30px;height:16px;border-radius:999px;background:#6b7280;transition:background .15s}',
  '.peak-guard-track[data-on="true"]{background:#2f6fed}',
  '.peak-guard-knob{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#fff;transition:transform .15s}',
  '.peak-guard-track[data-on="true"] .peak-guard-knob{transform:translateX(14px)}',
  '.peak-guard-dot{width:7px;height:7px;border-radius:50%;background:#6b7280;flex:none}',
  '.peak-guard-dot[data-on="true"]{background:#46bf6e}',
  '.peak-guard-dot[data-peak="true"][data-on="true"]{background:#e5484d}',
].join('')

/**
 * Read the host snapshot.
 * @returns {Promise<object | null>} the state, or null when unavailable.
 */
async function fetchState() {
  try {
    const response = await fetch(STATE_ROUTE, { cache: 'no-store' })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

/**
 * Write the switch.
 * @param {boolean} enabled - the new value.
 * @returns {Promise<object | null>} the resulting snapshot, or null on failure.
 */
async function postState(enabled) {
  try {
    const response = await fetch(STATE_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: enabled }),
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

/**
 * Render the one-line status under the name.
 *
 * Kept deliberately terse: the sidebar column is narrow, and the phase word
 * already says whether the quoted windows are the expensive ones, so repeating
 * "peak" before them would only push real information past the ellipsis.
 *
 * @param {object | null} state - the host snapshot.
 * @returns {string} a short human-readable standing.
 */
function statusLine(state) {
  if (state === null) return '无法读取状态'
  if (state.enabled !== true) return '已关闭：所有调用直接放行'
  const windows = (state.peakWindows || []).map(function (window) {
    return window.start + '-' + window.end
  }).join('、')
  const phase = state.peak === true ? '高峰价' : '空闲价'
  const suffix = windows === '' ? '' : ' · ' + windows
  return (state.localTime || '--:--') + ' ' + phase + suffix
}

/**
 * The sidebar row: name, live standing, and the switch.
 * @param {object} props - slot runtime props ("wide") plus the injected face.
 * @returns {object} the React element tree.
 */
function PeakGuardRow(props) {
  const wide = props.wide === true
  const stateHook = React.useState(null)
  const state = stateHook[0]
  const setState = stateHook[1]
  const busyHook = React.useState(false)
  const busy = busyHook[0]
  const setBusy = busyHook[1]

  React.useEffect(function () {
    let alive = true
    const load = async function () {
      const next = await fetchState()
      if (alive) setState(next)
    }
    void load()
    // The standing is time-sensitive (peak windows open and close) and the host
    // owns the clock, so a slow poll keeps the line honest without a socket.
    const timer = window.setInterval(load, 60000)
    return function () {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  const enabled = state !== null && state.enabled === true
  const peak = state !== null && state.peak === true
  const toggle = React.useCallback(async function () {
    if (busy) return
    setBusy(true)
    const next = await postState(!enabled)
    setBusy(false)
    // A failed write leaves the rendered state untouched, so the switch never
    // claims a change the host did not accept.
    if (next !== null) setState(next)
  }, [busy, enabled])

  const title = LABEL + '：' + (enabled ? '已启用' : '已关闭') + ' · ' + statusLine(state)

  if (!wide) {
    return React.createElement('button', {
      type: 'button',
      className: 'peak-guard-row peak-guard-rail',
      title: title,
      'aria-label': title,
      'aria-pressed': enabled,
      'data-build': BUILD_STAMP,
      onClick: function () { void toggle() },
    }, React.createElement('span', {
      className: 'peak-guard-dot',
      'data-on': String(enabled),
      'data-peak': String(peak),
    }))
  }

  return React.createElement('button', {
    type: 'button',
    className: 'peak-guard-row',
    title: title,
    'aria-pressed': enabled,
    'aria-label': title,
    'data-build': BUILD_STAMP,
    onClick: function () { void toggle() },
  },
  React.createElement('span', { className: 'peak-guard-text' },
    React.createElement('span', { className: 'peak-guard-name' }, LABEL),
    React.createElement('span', { className: 'peak-guard-status' }, statusLine(state))),
  React.createElement('span', { className: 'peak-guard-track', 'data-on': String(enabled) },
    React.createElement('span', { className: 'peak-guard-knob' })))
}

/** Services this client plugin needs before it activates. */
export const inject = ['slots', 'locale']

/**
 * Register the sidebar row.
 * @param {object} ctx - the client root context.
 * @returns {void}
 */
export function apply(ctx) {
  // One line naming the exact revision this page loaded, so a stale bundle is
  // identified from the console rather than deduced from a rendering symptom.
  console.info('[dsh-peak-guard] client build ' + BUILD_STAMP)

  ctx.effect(function () {
    const tagId = PLUGIN_ID + '/sidebar.css'
    if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return function () {}
    const tag = document.createElement('style')
    tag.dataset.plugin = PLUGIN_ID
    tag.dataset.pluginCss = tagId
    tag.textContent = STYLE
    document.head.appendChild(tag)
    return function () { tag.remove() }
  }, 'dsh-peak-guard: row styles')

  ctx.slots.inject('sidebar.footer.action', function () {
    return ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'peak-guard',
      // The injected stylesheet lets this container wrap, and this width is
      // what claims a full line inside it. A negative order puts that line
      // FIRST, so the row lands above the shipped updater row — and above
      // Settings below it — instead of sharing a line with either.
      order: -1,
      inject: function () { return {} },
    }, PeakGuardRow)
  })
}
