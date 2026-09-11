/**
 * Peak/off-peak (峰谷) arithmetic for DeepSeek model calls.
 *
 * Pure, dependency-free, and side-effect free so every branch can be unit
 * tested without booting a Cordis application. The plugin entry (`../index.js`)
 * owns all Cordis wiring and imports everything here.
 *
 * **Time assumption.** DeepSeek does not document whether the peak/off-peak
 * bucket is chosen by request start time, completion time, or invoice time.
 * This module classifies by the instant the call is dispatched, which is the
 * only instant a pre-dispatch guard can observe. The decision is therefore
 * labeled as an assumption in every prompt it renders.
 *
 * Model experience: none. Nothing in this module reaches a provider request.
 *
 * @module dsh-peak-guard/peak
 */

/** Weekday abbreviations as `Intl` renders them in the `en-US` locale. */
const WEEKEND = Object.freeze(['Sat', 'Sun'])

/** Substituted when a caller does not inject a clock (tests always do). */
const SYSTEM_CLOCK = () => new Date()

/**
 * Read the wall clock in one IANA zone.
 *
 * @param {Date} instant - the instant to render.
 * @param {string} timeZone - IANA zone name, e.g. `Asia/Shanghai`.
 * @returns {{ hour: number, minute: number, minutes: number, weekday: string, isWeekend: boolean, clock: string }} zoned fields.
 */
export function zonedFields(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).formatToParts(instant)
  const read = (type) => parts.find(part => part.type === type)?.value ?? ''
  // Some ICU builds render midnight as `24` under `hour12: false`; normalize it.
  const hour = Number(read('hour')) % 24
  const minute = Number(read('minute'))
  const weekday = read('weekday')
  return {
    hour,
    minute,
    minutes: hour * 60 + minute,
    weekday,
    isWeekend: WEEKEND.includes(weekday),
    clock: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  }
}

/**
 * Render a duration for a human.
 * @param {number} totalMinutes - minutes until the instant.
 * @returns {string} e.g. `2 小时 15 分钟`, `40 分钟`, `不到 1 分钟`.
 */
function renderCountdown(totalMinutes) {
  if (totalMinutes <= 0) return '不到 1 分钟'
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes} 分钟`
  if (minutes === 0) return `${hours} 小时`
  return `${hours} 小时 ${minutes} 分钟`
}

/**
 * Find when the next off-peak stretch begins, so a refusal can tell the user
 * what to wait for instead of only that a wait exists.
 *
 * Walks minute by minute to the next classified off-peak instant. A day is
 * fixed at 1440 minutes, so the scan is bounded and cannot loop: an instant
 * whose classification never flips is reported as unbounded rather than
 * spinning.
 *
 * @param {object} input - inputs.
 * @param {Date} input.now - the refusing instant.
 * @param {object[]} input.peakWindows - windows charged at the standard price.
 * @param {object[]} [input.offPeakWindows] - explicit discounted windows.
 * @param {string} input.timeZone - IANA zone the windows are quoted in.
 * @returns {{ clock: string, weekday: string, countdown: string, minutes: number, withinADay: boolean }} the next off-peak start.
 */
export function nextOffPeak({ now, peakWindows, offPeakWindows = [], timeZone }) {
  const MAX_MINUTES = 24 * 60
  for (let offset = 1; offset <= MAX_MINUTES; offset += 1) {
    const candidate = new Date(now.getTime() + offset * 60_000)
    const classification = classifyInstant({
      now: candidate,
      peakWindows,
      offPeakWindows,
      timeZone,
    })
    if (!classification.peak) {
      const zoned = classification.zoned
      return {
        clock: zoned.clock,
        weekday: zoned.weekday,
        countdown: renderCountdown(offset),
        minutes: offset,
        withinADay: true,
      }
    }
  }
  // Unreachable with the shipped windows; reported instead of assumed away.
  return { clock: '--:--', weekday: '', countdown: '一天以上', minutes: Number.POSITIVE_INFINITY, withinADay: false }
}

/**
 * Parse a `HH:MM` clock literal into minutes since local midnight.
 * @param {string} value - the literal, e.g. `08:30`.
 * @returns {number} minutes since midnight, in `[0, 1440)`.
 * @throws {TypeError} when the literal is not a valid `HH:MM` clock time.
 */
export function parseClock(value) {
  if (typeof value !== 'string') throw new TypeError(`clock must be a "HH:MM" string, got ${typeof value}`)
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (match === null) throw new TypeError(`clock must be a "HH:MM" string, got ${JSON.stringify(value)}`)
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) throw new TypeError(`not a valid clock time: ${value}`)
  return hour * 60 + minute
}

/**
 * Decide whether one window claims the given zoned moment.
 *
 * `start` is inclusive and `end` exclusive, so two adjacent windows never both
 * claim an instant. A window whose `end` is not after its `start` wraps past
 * midnight, which is how the retired `00:30–08:30` daily rule is expressed.
 * `weekdaysOnly` is what leaves weekend days entirely off-peak.
 *
 * @param {{ start: string, end: string, weekdaysOnly?: boolean }} window - the window.
 * @param {ReturnType<typeof zonedFields>} zoned - the moment to test.
 * @returns {boolean} whether the window claims this moment.
 */
export function windowClaims(window, zoned) {
  if (window.weekdaysOnly === true && zoned.isWeekend) return false
  const start = parseClock(window.start)
  const end = parseClock(window.end)
  return start <= end
    ? zoned.minutes >= start && zoned.minutes < end
    : zoned.minutes >= start || zoned.minutes < end
}

/**
 * Classify one instant against the configured windows.
 *
 * The model is DeepSeek's own: the peak list is exhaustive and "all other
 * hours are off-peak", so an instant no peak window claims is discounted. The
 * exclusive `offPeakWindows` list is consulted first, which lets a deployment
 * carve an exception out of a broad peak range (a public holiday inside a
 * weekday peak block, for example).
 *
 * @param {object} input - classification inputs.
 * @param {Date} input.now - the instant of the call.
 * @param {object[]} input.peakWindows - windows charged at the standard price.
 * @param {object[]} [input.offPeakWindows] - windows explicitly charged at the discounted price.
 * @param {string} input.timeZone - IANA zone the windows are quoted in.
 * @returns {{
 *   peak: boolean,
 *   offPeak: boolean,
 *   matched: object | null,
 *   basis: 'off-peak-window' | 'peak-window' | 'complement',
 *   zoned: ReturnType<typeof zonedFields>,
 * }} the classification.
 */
export function classifyInstant({ now, peakWindows, offPeakWindows = [], timeZone }) {
  const zoned = zonedFields(now, timeZone)
  const exception = offPeakWindows.find(window => windowClaims(window, zoned))
  if (exception !== undefined) {
    return { peak: false, offPeak: true, matched: exception, basis: 'off-peak-window', zoned }
  }
  const peakWindow = peakWindows.find(window => windowClaims(window, zoned))
  if (peakWindow !== undefined) {
    return { peak: true, offPeak: false, matched: peakWindow, basis: 'peak-window', zoned }
  }
  return { peak: false, offPeak: true, matched: null, basis: 'complement', zoned }
}

/**
 * Compile one glob (`*` = any run of characters) into an anchored RegExp.
 * @param {string} pattern - the glob text.
 * @returns {RegExp} an anchored, case-insensitive matcher.
 */
export function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*')
  return new RegExp(`^${escaped}$`, 'i')
}

/**
 * Match a candidate against an ordered list of globs.
 * @param {readonly string[]} patterns - glob patterns, e.g. `['deepseek-*']`.
 * @param {string} candidate - the value to classify.
 * @returns {boolean} whether any pattern matches.
 */
export function matchesAny(patterns, candidate) {
  return patterns.some(pattern => globToRegExp(pattern).test(candidate))
}

/**
 * Select the price row whose glob covers this route and model.
 *
 * Globs are tested against `provider/model`, so a route-scoped pattern is more
 * specific than a model-only one. Rows are ordered: the first row with any hit
 * wins, and the hit it reports is the first pattern in that row that matched.
 *
 * @param {readonly object[]} entries - `pricing` config rows, in order.
 * @param {string} provider - the provider route, e.g. `deepseek-official`.
 * @param {string} model - the model id, e.g. `deepseek-flash`.
 * @returns {{ match: string, entry: object } | undefined} the winning row.
 */
export function selectPricing(entries, provider, model) {
  const route = `${provider}/${model}`
  for (const entry of entries ?? []) {
    const patterns = Array.isArray(entry?.match) ? entry.match : []
    const hit = patterns.find(pattern => globToRegExp(pattern).test(route))
    if (hit !== undefined) return { match: hit, entry }
  }
  return undefined
}

/**
 * Render one price triple as `¥in/¥out` per million tokens, plus the cache-hit
 * input price, which DeepSeek quotes an order of magnitude lower.
 * @param {{ input?: number, output?: number, cacheHitInput?: number } | undefined} price - one price set.
 * @returns {string} a compact human-readable price.
 */
export function formatPrice(price) {
  if (price === undefined || price === null) return '?'
  const money = (value) => (typeof value === 'number' ? `¥${value}` : '?')
  const cache = typeof price.cacheHitInput === 'number' ? `，缓存命中 ¥${price.cacheHitInput}` : ''
  return `输入 ${money(price.input)}，输出 ${money(price.output)}${cache}（每百万 token）`
}

/**
 * Decide what a matching model call should do right now.
 *
 * @param {object} input - the decision inputs.
 * @param {Date} input.now - the instant of the call.
 * @param {object} input.config - a {@link normalizeConfig} result.
 * @param {{ provider?: string, model?: string, purpose?: string }} input.call - the intercepted call's identity.
 * @returns {{
 *   matched: boolean,
 *   action: 'allow' | 'confirm',
 *   reason: string,
 *   peak: boolean,
 *   offPeak: boolean,
 *   window: {
 *     localTime: string, weekday: string, timeZone: string, peak: string, offPeak: string,
 *     nextOffPeak?: { clock: string, weekday: string, countdown: string, minutes: number, withinADay: boolean },
 *     label?: string, basis: string,
 *   },
 *   pricing?: { match: string, entry: object },
 * }} the decision; `action: 'confirm'` means the gate must ask the human first.
 */
export function decide(input) {
  const { now, config, call } = input
  const classification = classifyInstant({
    now,
    peakWindows: config.peakWindows,
    offPeakWindows: config.offPeakWindows,
    timeZone: config.timeZone,
  })
  // The off-peak side of the prompt is only worth naming when it is more
  // specific than "everything else": an explicit exception list, or — while
  // blocking — the actual next transition, which is what a refusing user needs.
  const explicitOffPeak = renderWindows(config.offPeakWindows, config.timeZone)
  const next = classification.peak
    ? nextOffPeak({
      now,
      peakWindows: config.peakWindows,
      offPeakWindows: config.offPeakWindows,
      timeZone: config.timeZone,
    })
    : undefined
  const window = {
    localTime: classification.zoned.clock,
    weekday: classification.zoned.weekday,
    timeZone: config.timeZone,
    peak: renderWindows(config.peakWindows, config.timeZone) || '未配置高峰时段',
    offPeak: explicitOffPeak
      || (next === undefined
        ? '当前已是空闲时段'
        : `${next.clock}（${next.countdown}后）`),
    ...next === undefined ? {} : { nextOffPeak: next },
    ...classification.matched?.label === undefined ? {} : { label: classification.matched.label },
    basis: classification.basis,
  }
  const base = { peak: classification.peak, offPeak: classification.offPeak, window }
  const provider = call.provider ?? ''
  const model = call.model ?? ''
  if (!matchesAny(config.providerPatterns, provider)) {
    return { ...base, matched: false, action: 'allow', reason: 'not-target-provider' }
  }
  if (!matchesAny(config.modelPatterns, model)) {
    return { ...base, matched: false, action: 'allow', reason: 'not-target-model' }
  }
  if (call.purpose !== undefined && config.gateAuxiliary !== true) {
    return { ...base, matched: false, action: 'allow', reason: 'auxiliary-call' }
  }
  const pricing = selectPricing(config.pricing, provider, model)
  const priced = pricing === undefined ? {} : { pricing }
  if (classification.offPeak) {
    return { ...base, ...priced, matched: true, action: 'allow', reason: 'off-peak' }
  }
  if (config.requireConfirmation !== true) {
    return { ...base, ...priced, matched: true, action: 'allow', reason: 'peak-unconfirmed-by-config' }
  }
  return { ...base, ...priced, matched: true, action: 'confirm', reason: 'peak' }
}

/**
 * Render a window list for a human.
 * @param {object[]} windows - the configured windows.
 * @param {string} timeZone - the zone they are quoted in.
 * @returns {string} e.g. `09:00–12:00、14:00–18:00（仅周一至周五，Asia/Shanghai）`.
 */
function renderWindows(windows, timeZone) {
  if (windows.length === 0) return ''
  const body = windows
    .map(window => `${window.start}–${window.end}${window.weekdaysOnly === true ? '(周一至周五)' : ''}`)
    .join('、')
  return `${body}（${timeZone}）`
}

/**
 * Render the human-facing confirmation a peak-hour call asks.
 *
 * @param {object} input - presentation inputs.
 * @param {{ provider: string, model: string }} input.call - the intercepted route.
 * @param {ReturnType<typeof decide>} input.decision - the decision being confirmed.
 * @param {boolean} [input.showPrices] - include the price comparison (default true).
 * @param {string} [input.unaskableNote] - note appended when no answerer may exist.
 * @returns {{ question: string, detail: string, options: { label: string, description: string }[] }} the prompt.
 */
export function renderPrompt(input) {
  const { call, decision, showPrices = true, unaskableNote } = input
  const { window, pricing } = decision
  const priceLine = showPrices && pricing !== undefined
    ? `高峰价：${formatPrice(pricing.entry.peak)}\n空闲价：${formatPrice(pricing.entry.offPeak)}`
    : showPrices
      ? '未在 pricing 表中登记该模型价格，无法估算峰谷差额。'
      : ''
  const matchedLine = window.basis === 'complement'
    ? '当前时间未命中任何已配置的高峰时段标记。'
    : `当前处于高峰时段${window.label === undefined ? '' : `「${window.label}」`}。`
  const detail = [
    `模型路由：${call.provider}/${call.model}`,
    `当前时间：${window.localTime}（${window.weekday}，${window.timeZone}）`,
    matchedLine,
    `高峰时段：${window.peak}`,
    `空闲时段：${window.offPeak}`,
    priceLine,
    ...unaskableNote === undefined ? [] : [unaskableNote],
    '计费时段按「调用发起时刻」判定（官方未明确定义，此处为插件的判定假设）。',
  ].filter(line => line.length > 0)
  return {
    question: `当前为 DeepSeek 峰谷计费的「高峰时段」，是否确认调用 ${call.provider}/${call.model}？`,
    detail: detail.join('\n'),
    options: [
      { label: '确认调用', description: '按高峰价调用一次' },
      { label: '稍后重试', description: '中止本次调用（不产生费用），等空闲时段再试' },
    ],
  }
}
