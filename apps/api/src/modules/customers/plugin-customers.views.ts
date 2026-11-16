import { CustomerTimelineTypes } from '@platform/core/domain'

import type { TimelineEntry, TimelinePage } from './customer-timeline.service'
import type { CreatedCustomer, CustomerDetail } from './customers.views'
import type { NoteView } from './notes.service'

// The reason of a caution flag is text a member of the team wrote about a person (TDD_17 §4.16) and it is for the team: a plugin
// sees THAT the customer is flagged (`isCaution`) and never why, whatever scope it holds. The routes that set or clear the flag
// answer what the plugin itself sent, never what the team wrote.
// Field by field, so that a field the profile gains later (another text of the team) reaches a plugin only when someone adds it here.
export type PluginCustomerDetail = Omit<CustomerDetail, 'cautionReason'>
export type PluginCreatedCustomer = Omit<CreatedCustomer, 'cautionReason'>

export function pluginCustomerDetail(customer: CustomerDetail): PluginCustomerDetail {
  return {
    id: customer.id,
    name: customer.name,
    email: customer.email,
    phone: customer.phone,
    nationalPhone: customer.nationalPhone,
    locale: customer.locale,
    isCaution: customer.isCaution,
    identities: customer.identities,
    addresses: customer.addresses,
    tags: customer.tags,
    createdAt: customer.createdAt,
    updatedAt: customer.updatedAt
  }
}

export function pluginCreatedCustomer(customer: CreatedCustomer): PluginCreatedCustomer {
  return { ...pluginCustomerDetail(customer), possibleDuplicates: customer.possibleDuplicates }
}

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
