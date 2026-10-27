import { z } from 'zod'

import {
  CLOCK_TIME_PATTERN,
  RANGE_END_PATTERN,
  SettingsLimits,
  type Weekday
} from './settings-constants'

const timeRange = z
  .strictObject({
    from: z.string().regex(CLOCK_TIME_PATTERN),
    to: z.string().regex(RANGE_END_PATTERN)
  })
  .refine(range => range.from < range.to, { message: 'a range ends after it starts' })

// HH:mm strings compare as times with the plain operators of the checks below, so the order uses the
// same rule and not the one of the locale
const byStart = (a: { from: string }, b: { from: string }): number =>
  a.from < b.from ? -1 : a.from > b.from ? 1 : 0

// The ranges of a day, in order and apart from each other
const dayRanges = z
  .array(timeRange)
  .max(SettingsLimits.MAX_RANGES_PER_DAY)
  .transform(ranges => ranges.toSorted(byStart))
  .refine(
    ranges => ranges.every((range, i) => i === 0 || (ranges[i - 1]?.to ?? '') <= range.from),
    {
      message: 'the ranges of a day do not overlap'
    }
  )

// Every day is there, closed days as an empty list: the same keys as Weekdays
export const weekScheduleSchema = z.strictObject({
  mon: dayRanges,
  tue: dayRanges,
  wed: dayRanges,
  thu: dayRanges,
  fri: dayRanges,
  sat: dayRanges,
  sun: dayRanges
} satisfies Record<Weekday, typeof dayRanges>)
