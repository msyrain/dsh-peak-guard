/**
 * Deterministic tests for the peak/off-peak arithmetic.
 *
 * Every case pins an explicit instant, so the suite is independent of the
 * machine's clock and time zone. Run with `node --test tests/`.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  classifyInstant,
  decide,
  formatPrice,
  globToRegExp,
  matchesAny,
  nextOffPeak,
  parseClock,
  renderPrompt,
  selectPricing,
  windowClaims,
  zonedFields,
} from '../src/peak.js'
import { DEFAULT_PEAK_WINDOWS, DEFAULT_PRICING, normalizeConfig } from '../src/config.js'

/** A Wednesday inside the morning peak: 2026-09-09 10:00 Beijing = 02:00 UTC. */
const WED_MORNING_PEAK = new Date('2026-09-09T02:00:00Z')
/** A Wednesday inside the afternoon peak: 2026-09-09 15:00 Beijing = 07:00 UTC. */
const WED_AFTERNOON_PEAK = new Date('2026-09-09T07:00:00Z')
/** A Wednesday in the lunch trough: 2026-09-09 13:00 Beijing = 05:00 UTC. */
const WED_LUNCH = new Date('2026-09-09T05:00:00Z')
/** A Saturday inside the nominal morning peak hours: 2026-09-12 10:00 Beijing = 02:00 UTC. */
const SAT_MORNING = new Date('2026-09-12T02:00:00Z')
/** Monday 08:59 Beijing, one minute before the peak opens. */
const MON_JUST_BEFORE = new Date('2026-09-14T00:59:00Z')
/** Monday 09:00 Beijing, the first peak minute. */
const MON_PEAK_OPENS = new Date('2026-09-14T01:00:00Z')
/** Monday 12:00 Beijing, the first off-peak minute after the morning peak. */
const MON_MORNING_CLOSES = new Date('2026-09-14T04:00:00Z')
/** Monday 14:00 Beijing, the first peak minute of the afternoon. */
const MON_AFTERNOON_OPENS = new Date('2026-09-14T06:00:00Z')
/** Monday 18:00 Beijing, the first off-peak minute of the evening. */
const MON_EVENING_CLOSES = new Date('2026-09-14T10:00:00Z')

const config = normalizeConfig()

test('zonedFields renders Beijing wall-clock fields', () => {
  assert.deepEqual(
    pick(zonedFields(WED_MORNING_PEAK, 'Asia/Shanghai')),
    { clock: '10:00', weekday: 'Wed', isWeekend: false, minutes: 600 },
  )
  assert.deepEqual(
    pick(zonedFields(MON_JUST_BEFORE, 'Asia/Shanghai')),
    { clock: '08:59', weekday: 'Mon', isWeekend: false, minutes: 539 },
  )
})

test('zonedFields normalizes the midnight hour', () => {
  // 2026-09-10T16:00Z is 2026-09-11 00:00 Beijing.
  assert.equal(zonedFields(new Date('2026-09-10T16:00:00Z'), 'Asia/Shanghai').clock, '00:00')
})

test('parseClock accepts only a valid HH:MM literal', () => {
  assert.equal(parseClock('00:00'), 0)
  assert.equal(parseClock('9:05'), 545)
  assert.equal(parseClock('23:59'), 1439)
  assert.throws(() => parseClock('24:00'), /valid clock time/)
  assert.throws(() => parseClock('09:60'), /valid clock time/)
  assert.throws(() => parseClock('0900'), /HH:MM/)
  assert.throws(() => parseClock(900), /HH:MM/)
})

test('windowClaims treats start as inclusive and end as exclusive', () => {
  const window = { start: '09:00', end: '12:00', weekdaysOnly: true }
  assert.equal(windowClaims(window, zonedFields(MON_PEAK_OPENS, 'Asia/Shanghai')), true)
  assert.equal(windowClaims(window, zonedFields(MON_JUST_BEFORE, 'Asia/Shanghai')), false)
  assert.equal(windowClaims(window, zonedFields(MON_MORNING_CLOSES, 'Asia/Shanghai')), false)
})

test('windowClaims honors weekdaysOnly', () => {
  const window = { start: '09:00', end: '12:00', weekdaysOnly: true }
  assert.equal(windowClaims(window, zonedFields(SAT_MORNING, 'Asia/Shanghai')), false)
  assert.equal(windowClaims({ start: '09:00', end: '12:00' }, zonedFields(SAT_MORNING, 'Asia/Shanghai')), true)
})

test('windowClaims supports a window that wraps past midnight', () => {
  const wrapped = { start: '23:00', end: '01:00' }
  // 23:30 Beijing is after `start`; 00:30 the next day (16:30Z) is before `end`.
  assert.equal(windowClaims(wrapped, zonedFields(new Date('2026-09-09T15:30:00Z'), 'Asia/Shanghai')), true)
  assert.equal(windowClaims(wrapped, zonedFields(new Date('2026-09-09T16:30:00Z'), 'Asia/Shanghai')), true)
  // 02:00 Beijing is outside the wrapped range, and 18:00 Beijing is before it opens.
  assert.equal(windowClaims(wrapped, zonedFields(new Date('2026-09-09T18:00:00Z'), 'Asia/Shanghai')), false)
  assert.equal(windowClaims(wrapped, zonedFields(new Date('2026-09-09T10:00:00Z'), 'Asia/Shanghai')), false)
})

test('classifyInstant matches the official peak windows', () => {
  const classify = (now) => classifyInstant({
    now,
    peakWindows: DEFAULT_PEAK_WINDOWS,
    offPeakWindows: [],
    timeZone: 'Asia/Shanghai',
  })
  assert.equal(classify(WED_MORNING_PEAK).peak, true)
  assert.equal(classify(WED_AFTERNOON_PEAK).peak, true)
  assert.equal(classify(WED_LUNCH).peak, false)
  assert.equal(classify(SAT_MORNING).peak, false, 'weekends are entirely off-peak')
  assert.equal(classify(MON_MORNING_CLOSES).peak, false, 'the morning peak ends at 12:00')
  assert.equal(classify(MON_EVENING_CLOSES).peak, false, 'the afternoon peak ends at 18:00')
  assert.equal(classify(MON_AFTERNOON_OPENS).peak, true, 'the afternoon peak starts at 14:00')
  assert.equal(classify(MON_PEAK_OPENS).peak, true)
  assert.equal(classify(MON_JUST_BEFORE).peak, false)
  assert.equal(classify(WED_MORNING_PEAK).matched.label, '上午高峰')
})

test('classifyInstant treats unclaimed hours as off-peak, per the official rule', () => {
  const result = classifyInstant({
    now: WED_MORNING_PEAK,
    peakWindows: [{ start: '01:00', end: '02:00' }],
    offPeakWindows: [],
    timeZone: 'Asia/Shanghai',
  })
  assert.equal(result.peak, false)
  assert.equal(result.offPeak, true)
  assert.equal(result.basis, 'complement')
  assert.equal(result.matched, null)
})

test('classifyInstant reports which list decided the classification', () => {
  const peak = classifyInstant({
    now: WED_MORNING_PEAK,
    peakWindows: DEFAULT_PEAK_WINDOWS,
    timeZone: 'Asia/Shanghai',
  })
  assert.equal(peak.basis, 'peak-window')
  const exception = classifyInstant({
    now: WED_MORNING_PEAK,
    peakWindows: DEFAULT_PEAK_WINDOWS,
    offPeakWindows: [{ start: '09:00', end: '12:00', label: '公休' }],
    timeZone: 'Asia/Shanghai',
  })
  assert.equal(exception.basis, 'off-peak-window')
  assert.equal(exception.matched.label, '公休')
})

test('classifyInstant lets offPeakWindows carve an exception out of a peak range', () => {
  const result = classifyInstant({
    now: WED_MORNING_PEAK,
    peakWindows: [{ start: '09:00', end: '18:00' }],
    offPeakWindows: [{ start: '09:30', end: '11:00' }],
    timeZone: 'Asia/Shanghai',
  })
  assert.equal(result.offPeak, true)
  assert.equal(result.matched.start, '09:30')
})

test('globToRegExp anchors the pattern and escapes regex metacharacters', () => {
  assert.equal(globToRegExp('deepseek-*').test('deepseek-flash'), true)
  assert.equal(globToRegExp('deepseek-*').test('gpt-4'), false)
  assert.equal(globToRegExp('a.b').test('axb'), false)
  assert.equal(globToRegExp('*').test('anything'), true)
})

test('matchesAny treats an empty pattern list as no match', () => {
  assert.equal(matchesAny(['deepseek-*'], 'deepseek-official'), true)
  assert.equal(matchesAny([], 'deepseek-official'), false)
})

test('selectPricing matches the route and reports the winning pattern', () => {
  const hit = selectPricing(DEFAULT_PRICING, 'deepseek-official', 'deepseek-flash')
  assert.equal(hit.match, '*/deepseek-flash')
  assert.equal(hit.entry.peak.input, 2)
  assert.equal(hit.entry.offPeak.input, 1)
  assert.equal(selectPricing(DEFAULT_PRICING, 'deepseek-official', 'deepseek-v4-pro').entry.peak.output, 27)
  assert.equal(selectPricing(DEFAULT_PRICING, 'anthropic', 'claude'), undefined)
})

test('formatPrice renders both halves and the cache-hit input price', () => {
  assert.equal(formatPrice({ input: 2, output: 8, cacheHitInput: 0.04 }), '输入 ¥2，输出 ¥8，缓存命中 ¥0.04（每百万 token）')
  assert.equal(formatPrice(undefined), '?')
})

test('decide allows a non-DeepSeek route at peak', () => {
  const result = decide({
    now: WED_MORNING_PEAK,
    config,
    call: { provider: 'anthropic', model: 'claude' },
  })
  assert.equal(result.matched, false)
  assert.equal(result.action, 'allow')
  assert.equal(result.reason, 'not-target-provider')
})

test('decide allows a non-DeepSeek model on a DeepSeek route', () => {
  const result = decide({
    now: WED_MORNING_PEAK,
    config,
    call: { provider: 'deepseek-official', model: 'gpt-oss-20b' },
  })
  assert.equal(result.matched, false)
  assert.equal(result.reason, 'not-target-model')
})

test('decide asks for confirmation at peak', () => {
  const result = decide({
    now: WED_MORNING_PEAK,
    config,
    call: { provider: 'deepseek-official', model: 'deepseek-flash' },
  })
  assert.equal(result.matched, true)
  assert.equal(result.action, 'confirm')
  assert.equal(result.reason, 'peak')
  assert.equal(result.pricing.entry.label.startsWith('deepseek-flash'), true)
  assert.equal(result.window.localTime, '10:00')
})

test('nextOffPeak finds the transition a refusing user is waiting for', () => {
  // 10:00 Beijing sits inside the morning peak, which closes at 12:00.
  const fromMorning = nextOffPeak({
    now: WED_MORNING_PEAK,
    peakWindows: DEFAULT_PEAK_WINDOWS,
    timeZone: 'Asia/Shanghai',
  })
  assert.equal(fromMorning.clock, '12:00')
  assert.equal(fromMorning.countdown, '2 小时')
  assert.equal(fromMorning.minutes, 120)
  assert.equal(fromMorning.withinADay, true)

  // 15:00 sits inside the afternoon peak, which closes at 18:00.
  const fromAfternoon = nextOffPeak({
    now: WED_AFTERNOON_PEAK,
    peakWindows: DEFAULT_PEAK_WINDOWS,
    timeZone: 'Asia/Shanghai',
  })
  assert.equal(fromAfternoon.clock, '18:00')
  assert.equal(fromAfternoon.countdown, '3 小时')

  // 11:59 is the last peak minute, so the wait is a single minute.
  const lastMinute = nextOffPeak({
    now: new Date('2026-09-09T03:59:00Z'),
    peakWindows: DEFAULT_PEAK_WINDOWS,
    timeZone: 'Asia/Shanghai',
  })
  assert.equal(lastMinute.clock, '12:00')
  assert.equal(lastMinute.countdown, '1 分钟')
})

test('nextOffPeak reports an unbounded wait instead of spinning', () => {
  // Two wrapping windows tile the whole day, so no transition exists. The
  // bounded scan must report that instead of searching forever.
  const unbounded = nextOffPeak({
    now: WED_MORNING_PEAK,
    peakWindows: [
      { start: '00:00', end: '12:00' },
      { start: '12:00', end: '00:00' },
    ],
    timeZone: 'Asia/Shanghai',
  })
  assert.equal(unbounded.withinADay, false)
  assert.equal(unbounded.countdown, '一天以上')
})

test('the decision window names the next off-peak moment while blocking', () => {
  const result = decide({
    now: WED_MORNING_PEAK,
    config,
    call: { provider: 'deepseek-official', model: 'deepseek-flash' },
  })
  // "everything outside the peak windows" is true but useless to a user who is
  // being blocked; the clock time and the wait are what they can act on.
  assert.equal(result.window.offPeak, '12:00（2 小时后）')
  assert.equal(result.window.nextOffPeak.clock, '12:00')
})

test('an explicit off-peak list still wins over the computed hint', () => {
  const result = decide({
    now: WED_MORNING_PEAK,
    config: normalizeConfig({
      peakWindows: DEFAULT_PEAK_WINDOWS,
      offPeakWindows: [{ start: '12:00', end: '14:00', label: '午间' }],
    }),
    call: { provider: 'deepseek-official', model: 'deepseek-flash' },
  })
  assert.match(result.window.offPeak, /12:00–14:00/)
})

test('decide allows an off-peak call without asking', () => {
  const result = decide({
    now: WED_LUNCH,
    config,
    call: { provider: 'deepseek-official', model: 'deepseek-flash' },
  })
  assert.equal(result.action, 'allow')
  assert.equal(result.reason, 'off-peak')
  assert.equal(result.offPeak, true)
})

test('decide leaves auxiliary calls alone unless asked to gate them', () => {
  const call = { provider: 'deepseek-official', model: 'deepseek-flash', purpose: 'session-title' }
  assert.equal(decide({ now: WED_MORNING_PEAK, config, call }).reason, 'auxiliary-call')
  const gated = decide({ now: WED_MORNING_PEAK, config: normalizeConfig({ gateAuxiliary: true }), call })
  assert.equal(gated.action, 'confirm')
})

// The enabled/disabled switch is runtime state owned by the plugin entry and
// exercised in gate.test.js; `decide` itself only classifies and matches.
test('decide obeys requireConfirmation', () => {
  const call = { provider: 'deepseek-official', model: 'deepseek-flash' }
  assert.equal(
    decide({ now: WED_MORNING_PEAK, config: normalizeConfig({ requireConfirmation: false }), call }).reason,
    'peak-unconfirmed-by-config',
  )
  assert.equal(
    decide({ now: WED_MORNING_PEAK, config: normalizeConfig({ requireConfirmation: false }), call }).action,
    'allow',
  )
})

test('decide reports no pricing row for an unregistered model', () => {
  const result = decide({
    now: WED_MORNING_PEAK,
    config: normalizeConfig({ pricing: [] }),
    call: { provider: 'deepseek-official', model: 'deepseek-flash' },
  })
  assert.equal(result.action, 'confirm')
  assert.equal(result.pricing, undefined)
})

test('renderPrompt states the window, the prices, and the timing assumption', () => {
  const call = { provider: 'deepseek-official', model: 'deepseek-flash' }
  const decision = decide({ now: WED_MORNING_PEAK, config, call })
  const prompt = renderPrompt({ call, decision })
  assert.match(prompt.question, /高峰时段/)
  assert.match(prompt.question, /deepseek-official\/deepseek-flash/)
  assert.match(prompt.detail, /09:00–12:00/)
  assert.match(prompt.detail, /输入 ¥2，输出 ¥8/)
  assert.match(prompt.detail, /调用发起时刻/)
  assert.deepEqual(prompt.options.map(option => option.label), ['确认调用', '稍后重试'])
})

test('renderPrompt explains an off-peak exception window', () => {
  const call = { provider: 'deepseek-official', model: 'deepseek-flash' }
  // A broad peak range plus an exception claiming this exact instant: the
  // exception wins, so the decision is off-peak and no confirmation is asked.
  const decision = decide({
    now: WED_MORNING_PEAK,
    config: normalizeConfig({
      peakWindows: [{ start: '09:00', end: '18:00' }],
      offPeakWindows: [{ start: '10:00', end: '11:00' }],
    }),
    call,
  })
  assert.equal(decision.window.basis, 'off-peak-window')
  assert.equal(decision.action, 'allow')
  assert.equal(decision.reason, 'off-peak')
})

test('renderPrompt labels the matched peak window', () => {
  const call = { provider: 'deepseek-official', model: 'deepseek-flash' }
  const decision = decide({ now: WED_MORNING_PEAK, config, call })
  assert.equal(decision.window.basis, 'peak-window')
  assert.match(renderPrompt({ call, decision }).detail, /当前处于高峰时段「上午高峰」/)
})

test('normalizeConfig rejects a config that would silently disable the guard', () => {
  assert.throws(() => normalizeConfig({ peakWindows: [{ start: '9:00' }] }), /end/)
  assert.throws(() => normalizeConfig({ peakWindows: [{ start: '25:00', end: '26:00' }] }), /valid clock time/)
  assert.throws(() => normalizeConfig({ peakWindows: 'no' }), /must be an array/)
  assert.throws(() => normalizeConfig({ providerPatterns: [] }), /non-empty array/)
  assert.throws(() => normalizeConfig({ timeZone: 'Mars/Olympus' }), /unknown timeZone/)
  assert.throws(() => normalizeConfig({ unaskableAction: 'maybe' }), /unaskableAction/)
  assert.throws(() => normalizeConfig({ pricing: [{ label: 'x' }] }), /match/)
  assert.throws(() => normalizeConfig({ enabled: 'yes' }), /must be a boolean/)
})

test('normalizeConfig fills the shipped defaults', () => {
  const filled = normalizeConfig()
  assert.equal(filled.enabled, true)
  assert.deepEqual(filled.providerPatterns, ['deepseek-*'])
  assert.deepEqual(filled.modelPatterns, ['deepseek-*'])
  assert.equal(filled.timeZone, 'Asia/Shanghai')
  assert.equal(filled.unaskableAction, 'proceed')
  assert.equal(filled.peakWindows.length, 2)
  assert.equal(Object.isFrozen(filled), true)
})

test('normalizeConfig keeps an explicitly empty offPeakWindows list', () => {
  assert.deepEqual(normalizeConfig({ offPeakWindows: [] }).offPeakWindows, [])
})

/** Project the fields a test asserts on, keeping the deep-equal output readable. */
function pick({ clock, weekday, isWeekend, minutes }) {
  return { clock, weekday, isWeekend, minutes }
}
