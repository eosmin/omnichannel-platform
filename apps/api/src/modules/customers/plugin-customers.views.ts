import { CustomerTimelineTypes } from '@platform/core/domain'

import type { TimelineEntry, TimelinePage } from './customer-timeline.service'
import type { NoteView } from './notes.service'

// What a plugin sees of a note: the text and when, never who wrote it. The author is a member of the team (a user id and, in the
// timeline, a name), personal data of the staff that no scope grants (Step 5.6 PR E2).
export type PluginNoteView = Omit<NoteView, 'authorId'>

export function pluginNote(note: NoteView): PluginNoteView {
  return { id: note.id, content: note.content, createdAt: note.createdAt }
}

export type PluginTimelineEntry =
  | Exclude<
      TimelineEntry,
      { type: typeof CustomerTimelineTypes.NOTE | typeof CustomerTimelineTypes.MERGE }
    >
  | Omit<
      Extract<TimelineEntry, { type: typeof CustomerTimelineTypes.NOTE }>,
      'authorId' | 'authorName'
    >
  | Omit<
      Extract<TimelineEntry, { type: typeof CustomerTimelineTypes.MERGE }>,
      'mergedById' | 'mergedByName'
    >

// The timeline of the profile with the team members taken out of its notes and merges
export function pluginTimeline(
  page: TimelinePage
): Omit<TimelinePage, 'data'> & { data: PluginTimelineEntry[] } {
  return {
    ...page,
    data: page.data.map((entry): PluginTimelineEntry => {
      if (entry.type === CustomerTimelineTypes.NOTE) {
        return { type: entry.type, id: entry.id, at: entry.at, content: entry.content }
      }
      if (entry.type === CustomerTimelineTypes.MERGE) {
        return {
          type: entry.type,
          id: entry.id,
          at: entry.at,
          absorbedId: entry.absorbedId,
          unmergeUntil: entry.unmergeUntil,
          unmergedAt: entry.unmergedAt
        }
      }
      return entry
    })
  }
}
