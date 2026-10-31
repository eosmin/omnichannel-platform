import type { CustomerTimelineEntryView } from '@platform/api-client'

import { dayKeyOf, groupByDay } from './timeline-days'

const note = (id: string, at: string): CustomerTimelineEntryView => ({
  type: 'note',
  id,
  at,
  authorId: 'u1',
  authorName: null,
  content: 'text'
})

describe('groupByDay', () => {
  it('groups neighbours of the same day and keeps the order it came in', () => {
    const noon = new Date(2026, 9, 31, 12).toISOString()
    const morning = new Date(2026, 9, 31, 8).toISOString()
    const before = new Date(2026, 9, 30, 20).toISOString()

    const days = groupByDay([note('a', noon), note('b', morning), note('c', before)])

    expect(days.map(day => day.day)).toEqual(['2026-10-31', '2026-10-30'])
    expect(days[0]?.entries.map(entry => entry.id)).toEqual(['a', 'b'])
  })

  it('leaves out an entry with a date that does not parse', () => {
    expect(groupByDay([note('a', 'not a date')])).toEqual([])
  })

  it('writes the day in the local calendar, with two digits', () => {
    expect(dayKeyOf(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
  })
})
