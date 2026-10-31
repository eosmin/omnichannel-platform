import type { CustomerTimelineEntryView } from '@platform/api-client'

export interface TimelineDay {
  // The calendar day in the viewer's time zone, "2026-10-31": the key of the group
  day: string
  // The first entry's moment, to write the heading in the language of the interface
  date: Date
  entries: CustomerTimelineEntryView[]
}

const pad = (value: number): string => String(value).padStart(2, '0')

export function dayKeyOf(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

// The entries as the server sent them (the newest first), grouped by the day they happened. An entry
// whose date does not parse is left out: it would head a group called "Invalid Date".
export function groupByDay(entries: readonly CustomerTimelineEntryView[]): TimelineDay[] {
  const days: TimelineDay[] = []
  for (const entry of entries) {
    const at = new Date(entry.at)
    if (Number.isNaN(at.getTime())) continue
    const day = dayKeyOf(at)
    const last = days.at(-1)
    if (last?.day === day) last.entries.push(entry)
    else days.push({ day, date: at, entries: [entry] })
  }
  return days
}
