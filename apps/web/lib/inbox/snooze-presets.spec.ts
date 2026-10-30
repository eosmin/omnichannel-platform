import {
  instantAt,
  parseLocalDateTime,
  SnoozePresetId,
  snoozePresets,
  toLocalDateTimeValue
} from './snooze-presets'

const SALVADOR = 'America/El_Salvador' // UTC-6, no daylight saving
const NEW_YORK = 'America/New_York'

const untilOf = (now: string, timezone: string, id: SnoozePresetId): string | undefined =>
  snoozePresets(new Date(now), timezone)
    .find(preset => preset.id === id)
    ?.until.toISOString()

describe('snoozePresets', () => {
  it('counts later today as three hours from now', () => {
    expect(untilOf('2026-10-30T15:20:00Z', SALVADOR, SnoozePresetId.LATER_TODAY)).toBe(
      '2026-10-30T18:20:00.000Z'
    )
  })

  it('puts tomorrow morning at 9:00 of the store, not of the browser', () => {
    // Friday 2026-10-30 19:00 in El Salvador is already Saturday 01:00 UTC
    expect(untilOf('2026-10-31T01:00:00Z', SALVADOR, SnoozePresetId.TOMORROW_MORNING)).toBe(
      '2026-10-31T15:00:00.000Z'
    )
  })

  it('puts next week on the coming Monday at 9:00', () => {
    // Friday 2026-10-30 -> Monday 2026-11-02
    expect(untilOf('2026-10-30T15:00:00Z', SALVADOR, SnoozePresetId.NEXT_WEEK)).toBe(
      '2026-11-02T15:00:00.000Z'
    )
  })

  it('makes next week a full week away when today is Monday', () => {
    expect(untilOf('2026-11-02T15:00:00Z', SALVADOR, SnoozePresetId.NEXT_WEEK)).toBe(
      '2026-11-09T15:00:00.000Z'
    )
  })

  it('follows the daylight saving of the store: 9:00 is 13:00 UTC before the change and 14:00 after', () => {
    // New York falls back on 2026-11-01: Saturday night -> Monday morning crosses it
    expect(untilOf('2026-10-31T16:00:00Z', NEW_YORK, SnoozePresetId.NEXT_WEEK)).toBe(
      '2026-11-02T14:00:00.000Z'
    )
    expect(untilOf('2026-10-30T16:00:00Z', NEW_YORK, SnoozePresetId.TOMORROW_MORNING)).toBe(
      '2026-10-31T13:00:00.000Z'
    )
  })
})

describe('instantAt', () => {
  it('lands after the gap when the clocks skip the hour', () => {
    // New York springs forward on 2026-03-08: 02:30 does not exist
    const instant = instantAt({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, NEW_YORK)

    expect(instant.toISOString()).toBe('2026-03-08T07:30:00.000Z')
  })
})

describe('parseLocalDateTime', () => {
  it('reads the field as the wall clock of the store', () => {
    expect(parseLocalDateTime('2026-12-24T08:30', SALVADOR)?.toISOString()).toBe(
      '2026-12-24T14:30:00.000Z'
    )
  })

  it.each(['', '2026-12-24', '2026-02-30T10:00', '2026-12-24T24:00', '2026-12-24T10:60'])(
    'rejects %p',
    value => {
      expect(parseLocalDateTime(value, SALVADOR)).toBeNull()
    }
  )
})

describe('toLocalDateTimeValue', () => {
  it('writes the wall clock of the store for the field', () => {
    expect(toLocalDateTimeValue(new Date('2026-10-31T01:05:00Z'), SALVADOR)).toBe(
      '2026-10-30T19:05'
    )
  })
})
