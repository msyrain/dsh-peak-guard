/**
 * Configuration defaults, validation, and the Schemastery schema for the
 * DeepSeek peak/off-peak guard.
 *
 * Sources for the shipped defaults (verified against the official pricing page
 * on 2026-09-10):
 *
 * - Pricing footnote 3: "Off-peak rates are half of the peak rates. Peak hours
 *   are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday (all other
 *   hours are off-peak)." In Beijing time (UTC+8, no DST) that is Monday-Friday
 *   09:00-12:00 and 14:00-18:00; weekends are entirely off-peak.
 * - <https://api-docs.deepseek.com/quick_start/pricing>
 *
 * The 2025-era "00:30-08:30 daily" window is retired; {@link LEGACY_WINDOW}
 * keeps it available as a documented alternative for anyone still billed under
 * it.
 *
 * The same default table serves both callers: Cordis validates
 * {@link loadConfigSchema} once at load, and {@link normalizeConfig} fills the
 * same values for a bare call (a unit test, or a bundle row with no `config`).
 * One table is what stops the two from drifting.
 *
 * @module dsh-peak-guard/config
 */

/** DeepSeek quotes both its price list and its peak windows in Beijing time. */
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai'

/** Labels offered by the peak-hour confirmation. */
export const APPROVE_LABEL = '确认调用'
/** Label whose selection refuses this one model call. */
export const REJECT_LABEL = '稍后重试'

/**
 * The current official peak windows, in Beijing time.
 *
 * `weekdaysOnly` is what makes weekends cheaper: a window that only matches
 * Monday-Friday leaves Saturday and Sunday entirely off-peak, exactly as the
 * pricing footnote states. `start` is inclusive and `end` exclusive, so
 * adjacent windows never both claim an instant.
 */
export const DEFAULT_PEAK_WINDOWS = Object.freeze([
  Object.freeze({ start: '09:00', end: '12:00', weekdaysOnly: true, label: '上午高峰' }),
  Object.freeze({ start: '14:00', end: '18:00', weekdaysOnly: true, label: '下午高峰' }),
])

/**
 * The retired 2025-02-26 rule: a single daily 00:30-08:30 off-peak window.
 * Kept as documentation and as a drop-in `peakWindows` / `offPeakWindows`
 * value for deployments still billed under it.
 */
export const LEGACY_OFF_PEAK_WINDOW = Object.freeze({ start: '00:30', end: '08:30' })

/**
 * Price rows per million tokens (CNY). `match` globs are tested against
 * `provider/model`, so a route-scoped pattern is more specific than a
 * model-only one. Both halves of every row are quoted: `peak` is the standard
 * price and `offPeak` its discounted counterpart (exactly half).
 *
 * These are deployment-editable defaults, not billing truth: DeepSeek reserves
 * the right to change its list, so a row a user cares about belongs in their
 * own `cordis.patch.yml`.
 */
export const DEFAULT_PRICING = Object.freeze([
  Object.freeze({
    match: Object.freeze(['*/deepseek-flash', 'deepseek-flash', '*/deepseek-v4-flash*', 'deepseek-v4-flash*']),
    label: 'deepseek-flash (DeepSeek-V4.1-Flash)',
    peak: Object.freeze({ input: 2, cacheHitInput: 0.04, output: 8 }),
    offPeak: Object.freeze({ input: 1, cacheHitInput: 0.02, output: 4 }),
    discount: '空闲时段为高峰时段的一半',
  }),
  Object.freeze({
    match: Object.freeze(['*/deepseek-v4-pro', 'deepseek-v4-pro']),
    label: 'deepseek-v4-pro (DeepSeek-V4-Pro-0813)',
    peak: Object.freeze({ input: 9, cacheHitInput: 0.3, output: 27 }),
    offPeak: Object.freeze({ input: 4.5, cacheHitInput: 0.15, output: 13.5 }),
    discount: '空闲时段为高峰时段的一半（2026-09-14 起该路由改按 flash 计价）',
  }),
  Object.freeze({
    match: Object.freeze(['*/deepseek-chat', 'deepseek-chat', '*/deepseek-reasoner', 'deepseek-reasoner']),
    label: 'deepseek-chat / deepseek-reasoner（已于 2026-07-24 下线，保留以便旧账户参考）',
    peak: Object.freeze({ input: 2, cacheHitInput: 0.5, output: 8 }),
    offPeak: Object.freeze({ input: 1, cacheHitInput: 0.25, output: 4 }),
    discount: '历史价格',
  }),
])

/** Every default {@link normalizeConfig} fills. */
const DEFAULTS = Object.freeze({
  enabled: true,
  providerPatterns: Object.freeze(['deepseek-*']),
  modelPatterns: Object.freeze(['deepseek-*']),
  gateAuxiliary: false,
  requireConfirmation: true,
  peakWindows: DEFAULT_PEAK_WINDOWS,
  offPeakWindows: Object.freeze([]),
  timeZone: DEFAULT_TIME_ZONE,
  notifyOffPeak: false,
  unaskableAction: 'proceed',
  localAgentsOnly: true,
  showPrices: true,
  suppressRepeatAsks: true,
  askScope: 'window',
  pricing: DEFAULT_PRICING,
})

/** Values {@link normalizeConfig}'s `unaskableAction` accepts. */
const UNASKABLE_ACTIONS = Object.freeze(['proceed', 'block'])

/**
 * Values {@link normalizeConfig}'s `askScope` accepts.
 *
 * `window` is the shipped default because confirming every single model call of
 * a peak session is a high-frequency interruption: one approval covers the rest
 * of that peak window.
 */
const ASK_SCOPES = Object.freeze(['window', 'call'])

/**
 * Fill every default and reject a config the plugin cannot honor.
 *
 * Validation is deliberately loud: a malformed window or glob would otherwise
 * turn the guard into a silent no-op, which is the one failure mode a cost
 * guard must not have.
 *
 * @param {object} [raw] - loader-supplied row config.
 * @returns {object} a frozen, fully-populated config.
 * @throws {TypeError} when a value is outside the vocabulary this plugin implements.
 */
export function normalizeConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object') {
    throw new TypeError('dsh-peak-guard: config must be a table')
  }
  const config = { ...DEFAULTS, ...raw }
  for (const key of ['enabled', 'gateAuxiliary', 'requireConfirmation', 'notifyOffPeak', 'localAgentsOnly', 'showPrices', 'suppressRepeatAsks']) {
    if (typeof config[key] !== 'boolean') {
      throw new TypeError(`dsh-peak-guard: ${key} must be a boolean`)
    }
  }
  if (!ASK_SCOPES.includes(config.askScope)) {
    throw new TypeError(
      `dsh-peak-guard: askScope must be one of ${ASK_SCOPES.join(', ')}, got ${JSON.stringify(config.askScope)}`,
    )
  }
  config.providerPatterns = normalizeGlobs(config.providerPatterns, 'providerPatterns')
  config.modelPatterns = normalizeGlobs(config.modelPatterns, 'modelPatterns')
  if (typeof config.timeZone !== 'string' || config.timeZone.length === 0) {
    throw new TypeError('dsh-peak-guard: timeZone must be a non-empty IANA zone name')
  }
  assertTimeZone(config.timeZone)
  config.peakWindows = normalizeWindows(config.peakWindows, 'peakWindows')
  config.offPeakWindows = normalizeWindows(config.offPeakWindows ?? [], 'offPeakWindows')
  if (!UNASKABLE_ACTIONS.includes(config.unaskableAction)) {
    throw new TypeError(
      `dsh-peak-guard: unaskableAction must be one of ${UNASKABLE_ACTIONS.join(', ')}, `
      + `got ${JSON.stringify(config.unaskableAction)}`,
    )
  }
  config.pricing = normalizePricing(config.pricing)
  return Object.freeze(config)
}

/**
 * Validate one window list.
 * @param {unknown} value - the candidate list.
 * @param {string} label - config field name for the error message.
 * @returns {object[]} a fresh validated list.
 * @throws {TypeError} when the value is not an array of well-formed windows.
 */
function normalizeWindows(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`dsh-peak-guard: ${label} must be an array`)
  return value.map((window, index) => {
    if (window === null || typeof window !== 'object') {
      throw new TypeError(`dsh-peak-guard: ${label}[${index}] must be a table with start and end`)
    }
    const { start, end, weekdaysOnly, label: windowLabel } = window
    assertClock(start, `${label}[${index}].start`)
    assertClock(end, `${label}[${index}].end`)
    if (weekdaysOnly !== undefined && typeof weekdaysOnly !== 'boolean') {
      throw new TypeError(`dsh-peak-guard: ${label}[${index}].weekdaysOnly must be a boolean`)
    }
    if (windowLabel !== undefined && typeof windowLabel !== 'string') {
      throw new TypeError(`dsh-peak-guard: ${label}[${index}].label must be a string`)
    }
    return {
      start,
      end,
      ...weekdaysOnly === undefined ? {} : { weekdaysOnly },
      ...windowLabel === undefined ? {} : { label: windowLabel },
    }
  })
}

/**
 * Validate the price table.
 * @param {unknown} value - the candidate table.
 * @returns {object[]} a fresh validated table.
 * @throws {TypeError} when a row is malformed.
 */
function normalizePricing(value) {
  if (!Array.isArray(value)) throw new TypeError('dsh-peak-guard: pricing must be an array')
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== 'object') {
      throw new TypeError(`dsh-peak-guard: pricing[${index}] must be a table`)
    }
    if (!Array.isArray(entry.match) || entry.match.length === 0) {
      throw new TypeError(`dsh-peak-guard: pricing[${index}].match must be a non-empty glob list`)
    }
    for (const pattern of entry.match) {
      if (typeof pattern !== 'string' || pattern.length === 0) {
        throw new TypeError(`dsh-peak-guard: pricing[${index}].match entries must be non-empty strings`)
      }
    }
    return { ...entry, match: [...entry.match] }
  })
}

/**
 * Validate one glob list.
 * @param {unknown} value - the candidate list.
 * @param {string} label - config field name for the error message.
 * @returns {string[]} a fresh validated array.
 * @throws {TypeError} when the value is not a non-empty array of non-empty strings.
 */
function normalizeGlobs(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`dsh-peak-guard: ${label} must be a non-empty array of glob strings`)
  }
  for (const pattern of value) {
    if (typeof pattern !== 'string' || pattern.length === 0) {
      throw new TypeError(`dsh-peak-guard: ${label} entries must be non-empty strings`)
    }
  }
  return [...value]
}

/**
 * Reject a clock literal the window parser would silently misread.
 * @param {unknown} value - the candidate literal.
 * @param {string} label - field name used in the thrown message.
 * @throws {TypeError} when the literal is not a valid `HH:MM` clock time.
 */
function assertClock(value, label) {
  if (typeof value !== 'string' || !/^\d{1,2}:\d{2}$/.test(value)) {
    throw new TypeError(`dsh-peak-guard: ${label} must be a "HH:MM" string, got ${JSON.stringify(value)}`)
  }
  const [hour, minute] = value.split(':').map(Number)
  if (hour > 23 || minute > 59) {
    throw new TypeError(`dsh-peak-guard: ${label} is not a valid clock time: ${value}`)
  }
}

/**
 * Reject an unknown IANA zone at load rather than at the first model call.
 * @param {string} timeZone - the candidate zone name.
 * @throws {TypeError} when the runtime's ICU data does not know the zone.
 */
function assertTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0))
  } catch {
    throw new TypeError(`dsh-peak-guard: unknown timeZone ${JSON.stringify(timeZone)}`)
  }
}

/**
 * Build the Schemastery schema for {@link DEFAULTS}.
 *
 * Loaded lazily so the plugin still works in a composition that mounts no
 * schema validator; {@link normalizeConfig} remains the authority either way.
 *
 * @returns {Promise<object | undefined>} the schema, or undefined when Schemastery is unavailable.
 */
export async function loadConfigSchema() {
  try {
    const { default: Schema } = await import('@deepseek-ai/schemastery')
    const price = Schema.object({
      input: Schema.number(),
      cacheHitInput: Schema.number(),
      output: Schema.number(),
    })
    const window = Schema.object({
      start: Schema.string().required(),
      end: Schema.string().required(),
      weekdaysOnly: Schema.boolean(),
      label: Schema.string(),
    })
    return Schema.object({
      enabled: Schema.boolean().default(true),
      providerPatterns: Schema.array(Schema.string()).default(['deepseek-*']),
      modelPatterns: Schema.array(Schema.string()).default(['deepseek-*']),
      gateAuxiliary: Schema.boolean().default(false),
      requireConfirmation: Schema.boolean().default(true),
      peakWindows: Schema.array(window).default(DEFAULT_PEAK_WINDOWS),
      offPeakWindows: Schema.array(window).default([]),
      timeZone: Schema.string().default(DEFAULT_TIME_ZONE),
      notifyOffPeak: Schema.boolean().default(false),
      unaskableAction: Schema.union(['proceed', 'block']).default('proceed'),
      localAgentsOnly: Schema.boolean().default(true),
      showPrices: Schema.boolean().default(true),
      suppressRepeatAsks: Schema.boolean().default(true),
      askScope: Schema.union(['window', 'call']).default('window'),
      pricing: Schema.array(Schema.object({
        match: Schema.array(Schema.string()).required(),
        label: Schema.string(),
        peak: price,
        offPeak: price,
        discount: Schema.string(),
      })).default(DEFAULT_PRICING),
    })
  } catch {
    return undefined
  }
}
