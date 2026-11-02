import {
  CLOCK_TIME_PATTERN,
  RANGE_END_PATTERN,
  SettingsLimits,
  type Weekday,
  Weekdays
} from '@platform/core/domain'

import type { HoursRange, WeekSchedule } from './hours-requests'

// The week of Settings → Business hours as the form edits it, and the checks the api repeats
// (`weekScheduleSchema`): a range ends after it starts, the ranges of a day do not overlap, and a day
// has at most MAX_RANGES_PER_DAY. Times are 24-hour HH:mm, so they compare as text.

// A range added after the others must start before this to end at 23:59
const LAST_START = '23:00'

export const DEFAULT_RANGE: HoursRange = { from: '09:00', to: '18:00' }

// Monday to Friday: the first five days of Weekdays
export const WORKING_DAYS = 5

export function closedWeek(): WeekSchedule {
  return Object.fromEntries(Weekdays.map(day => [day, []])) as unknown as WeekSchedule
}

export const HoursProblems = {
  BAD_TIME: 'badTime',
  ENDS_BEFORE_START: 'endsBeforeStart',
  OVERLAP: 'overlap',
  TOO_MANY: 'tooMany'
} as const
export type HoursProblem = (typeof HoursProblems)[keyof typeof HoursProblems]

export function setRange(
  schedule: WeekSchedule,
  day: Weekday,
  index: number,
  range: HoursRange
): WeekSchedule {
  return { ...schedule, [day]: schedule[day].map((old, i) => (i === index ? range : old)) }
}

export function addRange(schedule: WeekSchedule, day: Weekday): WeekSchedule {
  const ranges = schedule[day]
  if (ranges.length >= SettingsLimits.MAX_RANGES_PER_DAY) return schedule
  // The next range starts where the latest one ends, when there is room before midnight; with no
  // room it is not added, since any range would overlap one that is there
  const latestEnd = ranges.reduce((end, range) => (range.to > end ? range.to : end), '')
  if (ranges.length > 0 && latestEnd >= LAST_START) return schedule
  const next = ranges.length === 0 ? DEFAULT_RANGE : { from: latestEnd, to: '23:59' }
  return { ...schedule, [day]: [...ranges, next] }
}

export function removeRange(schedule: WeekSchedule, day: Weekday, index: number): WeekSchedule {
  return { ...schedule, [day]: schedule[day].filter((_, i) => i !== index) }
}

// The same hours on other days: what "copy to weekdays" does
export function copyDay(
  schedule: WeekSchedule,
  from: Weekday,
  to: readonly Weekday[]
): WeekSchedule {
  const next = { ...schedule }
  for (const day of to) if (day !== from) next[day] = schedule[from].map(range => ({ ...range }))
  return next
}

export function dayProblems(ranges: readonly HoursRange[]): HoursProblem[] {
  const problems = new Set<HoursProblem>()
  if (ranges.length > SettingsLimits.MAX_RANGES_PER_DAY) problems.add(HoursProblems.TOO_MANY)
  for (const range of ranges) {
    if (!CLOCK_TIME_PATTERN.test(range.from) || !RANGE_END_PATTERN.test(range.to)) {
      problems.add(HoursProblems.BAD_TIME)
    } else if (range.from >= range.to) {
      problems.add(HoursProblems.ENDS_BEFORE_START)
    }
  }
  const sorted = ranges.toSorted((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
  if (sorted.some((range, i) => i > 0 && (sorted[i - 1]?.to ?? '') > range.from)) {
    problems.add(HoursProblems.OVERLAP)
  }
  return [...problems]
}

export function weekProblems(schedule: WeekSchedule): Partial<Record<Weekday, HoursProblem[]>> {
  const found: Partial<Record<Weekday, HoursProblem[]>> = {}
  for (const day of Object.keys(schedule) as Weekday[]) {
    const problems = dayProblems(schedule[day])
    if (problems.length > 0) found[day] = problems
  }
  return found
}

const STEP_MINUTES = 15

const CLOCK_TIMES: readonly string[] = Array.from({ length: (24 * 60) / STEP_MINUTES }, (_, i) => {
  const minutes = i * STEP_MINUTES
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
})

// The choices of a time field: every quarter of an hour, plus midnight (24:00) when it is an end, plus
// the value the range holds now if it is none of those (hours saved through the api)
export function timeOptions(current: string, isEnd: boolean): string[] {
  const options = isEnd ? [...CLOCK_TIMES.slice(1), '24:00'] : [...CLOCK_TIMES]
  return options.includes(current) ? options : [...options, current].toSorted()
}
