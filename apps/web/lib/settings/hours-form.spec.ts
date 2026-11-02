import { SettingsLimits } from '@platform/core/domain'

import {
  addRange,
  closedWeek,
  copyDay,
  dayProblems,
  DEFAULT_RANGE,
  HoursProblems,
  removeRange,
  setRange,
  timeOptions,
  weekProblems
} from './hours-form'

describe('editing a week', () => {
  it('opens a day with the default hours and adds a range after the last one', () => {
    const open = addRange(closedWeek(), 'mon')
    expect(open.mon).toEqual([DEFAULT_RANGE])
    expect(addRange(open, 'mon').mon).toEqual([DEFAULT_RANGE, { from: '18:00', to: '23:59' }])
  })

  it('starts a new range after the latest end, whatever the order, and adds none when there is no room', () => {
    const week = {
      ...closedWeek(),
      mon: [
        { from: '14:00', to: '18:00' },
        { from: '09:00', to: '12:00' }
      ]
    }
    expect(addRange(week, 'mon').mon.at(-1)).toEqual({ from: '18:00', to: '23:59' })
    const late = { ...closedWeek(), mon: [{ from: '09:00', to: '23:30' }] }
    expect(addRange(late, 'mon')).toBe(late)
    const midnight = { ...closedWeek(), mon: [{ from: '09:00', to: '24:00' }] }
    expect(addRange(midnight, 'mon')).toBe(midnight)
  })

  it('does not add past the limit of a day', () => {
    const full = {
      ...closedWeek(),
      tue: [
        { from: '01:00', to: '02:00' },
        { from: '03:00', to: '04:00' },
        { from: '05:00', to: '06:00' },
        { from: '07:00', to: '08:00' }
      ]
    }
    expect(full.tue).toHaveLength(SettingsLimits.MAX_RANGES_PER_DAY)
    expect(addRange(full, 'tue')).toBe(full)
  })

  it('changes and removes one range without touching the other days', () => {
    const week = addRange(addRange(closedWeek(), 'wed'), 'thu')
    const changed = setRange(week, 'wed', 0, { from: '10:00', to: '12:00' })
    expect(changed.wed).toEqual([{ from: '10:00', to: '12:00' }])
    expect(changed.thu).toEqual(week.thu)
    expect(removeRange(changed, 'wed', 0).wed).toEqual([])
  })

  it('copies a day to others as new objects', () => {
    const week = addRange(closedWeek(), 'mon')
    const copied = copyDay(week, 'mon', ['mon', 'tue', 'fri'])
    expect(copied.tue).toEqual(week.mon)
    expect(copied.fri).toEqual(week.mon)
    expect(copied.sat).toEqual([])
    expect(copied.tue[0]).not.toBe(week.mon[0])
  })
})

describe('dayProblems', () => {
  it('accepts closed days and ordered, separate ranges, with midnight as an end', () => {
    expect(dayProblems([])).toEqual([])
    expect(
      dayProblems([
        { from: '08:00', to: '12:00' },
        { from: '12:00', to: '24:00' }
      ])
    ).toEqual([])
  })

  it('refuses a range that ends before it starts or is empty', () => {
    expect(dayProblems([{ from: '12:00', to: '08:00' }])).toEqual([HoursProblems.ENDS_BEFORE_START])
    expect(dayProblems([{ from: '08:00', to: '08:00' }])).toEqual([HoursProblems.ENDS_BEFORE_START])
  })

  it('refuses a time that is not a 24-hour clock time', () => {
    expect(dayProblems([{ from: '8:00', to: '12:00' }])).toEqual([HoursProblems.BAD_TIME])
    expect(dayProblems([{ from: '08:00', to: '25:00' }])).toEqual([HoursProblems.BAD_TIME])
    expect(dayProblems([{ from: '24:00', to: '24:00' }])).toEqual([HoursProblems.BAD_TIME])
  })

  it('refuses ranges that overlap, in whatever order they were typed', () => {
    expect(
      dayProblems([
        { from: '13:00', to: '18:00' },
        { from: '09:00', to: '14:00' }
      ])
    ).toEqual([HoursProblems.OVERLAP])
  })

  it('refuses more ranges than a day may have', () => {
    const many = Array.from({ length: SettingsLimits.MAX_RANGES_PER_DAY + 1 }, (_, i) => ({
      from: `0${i}:00`,
      to: `0${i}:30`
    }))
    expect(dayProblems(many)).toEqual([HoursProblems.TOO_MANY])
  })
})

describe('weekProblems', () => {
  it('names the days that have one', () => {
    const week = setRange(addRange(closedWeek(), 'sat'), 'sat', 0, { from: '10:00', to: '09:00' })
    expect(weekProblems(week)).toEqual({ sat: [HoursProblems.ENDS_BEFORE_START] })
    expect(weekProblems(closedWeek())).toEqual({})
  })
})

describe('timeOptions', () => {
  it('offers every quarter of an hour, and midnight only as an end', () => {
    const starts = timeOptions('09:00', false)
    expect(starts).toHaveLength(96)
    expect(starts[0]).toBe('00:00')
    expect(starts).not.toContain('24:00')
    const ends = timeOptions('18:00', true)
    expect(ends).not.toContain('00:00')
    expect(ends.at(-1)).toBe('24:00')
  })

  it('keeps a value that the api holds and the steps do not', () => {
    expect(timeOptions('09:10', false)).toContain('09:10')
    expect(timeOptions('09:10', false)).toHaveLength(97)
  })
})
