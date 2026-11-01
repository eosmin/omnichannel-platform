import { z } from 'zod'

import {
  BulkActions,
  BulkLimits,
  channelIdSchema,
  ConversationAssignedFilters,
  ConversationLimits,
  ConversationStatus,
  PaginationLimits,
  RoutingLimits,
  uuidSchema
} from '@platform/core/domain'

import { conversationCursorSchema } from './conversation-cursor'

const assigned = z.union([
  z.literal(ConversationAssignedFilters.ME),
  z.literal(ConversationAssignedFilters.UNASSIGNED),
  uuidSchema
])

// A query string carries text: only the two words are a boolean
const flag = z.enum(['true', 'false']).transform(value => value === 'true')

// What narrows a list: the list takes it in the query string, a bulk action in the body
export const conversationFilterSchema = z.strictObject({
  assigned: assigned.optional(),
  status: z.enum(ConversationStatus).optional(),
  channelType: channelIdSchema.optional(),
  tagId: uuidSchema.optional()
})

export const listConversationsQuerySchema = z
  .strictObject({
    cursor: conversationCursorSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(PaginationLimits.MAX)
      .default(PaginationLimits.DEFAULT),
    assigned: assigned.optional(),
    status: z.enum(ConversationStatus).optional(),
    channelType: channelIdSchema.optional(),
    tagId: uuidSchema.optional(),
    countsOnly: flag.default(false)
  })
  .refine(
    query =>
      !query.countsOnly ||
      [query.cursor, query.assigned, query.status, query.channelType, query.tagId].every(
        value => value === undefined
      ),
    { message: 'the counts are not filtered: countsOnly takes no filter or cursor' }
  )

// SNOOZED has its own route: it needs the moment the conversation comes back
const settableStatus = z.enum([
  ConversationStatus.OPEN,
  ConversationStatus.PENDING,
  ConversationStatus.RESOLVED,
  ConversationStatus.ARCHIVED,
  ConversationStatus.SPAM
])

export const changeStatusSchema = z
  .strictObject({
    status: settableStatus,
    resolutionReason: z
      .string()
      .trim()
      .min(1)
      .max(ConversationLimits.RESOLUTION_REASON_MAX_LENGTH)
      .refine(value => !value.includes('\0'), { message: 'contains a NUL character' })
      .optional(),
    // The saved reply sent to the customer once the Undo is over; the api reads its text
    closingSnippetId: uuidSchema.optional()
  })
  .refine(
    body => body.resolutionReason === undefined || body.status === ConversationStatus.RESOLVED,
    {
      message: 'a resolution reason goes with resolving'
    }
  )
  .refine(
    body => body.closingSnippetId === undefined || body.status === ConversationStatus.RESOLVED,
    { message: 'a closing message goes with resolving' }
  )

export const assignSchema = z.strictObject({ userId: uuidSchema.nullable() })

export const snoozeSchema = z.strictObject({
  until: z.iso.datetime({ offset: true }).transform(value => new Date(value))
})

export const attachTagSchema = z.strictObject({ tagId: uuidSchema })

// The conversations a bulk action reaches: the ones named, or the ones that match a filter (capped at
// BulkLimits.MAX_ITEMS by the server). Exactly one of the two.
const bulkTarget = {
  conversationIds: z
    .array(uuidSchema.transform(id => id.toLowerCase()))
    .min(1)
    .max(BulkLimits.MAX_ITEMS)
    .refine(ids => new Set(ids).size === ids.length, { message: 'a conversation is named once' })
    .optional(),
  // A filter that names nothing would reach every conversation the caller sees: a bulk action says
  // at least one thing it selects by
  filter: conversationFilterSchema
    .refine(filter => Object.values(filter).some(value => value !== undefined), {
      message: 'a filter names at least one field'
    })
    .optional()
}

// The actions that are built. SEND_TEMPLATE is Phase 2 and is not accepted here. EXPORT_CSV makes a file
// in the exports center instead of changing the conversations.
export const bulkActionSchema = z
  .discriminatedUnion('action', [
    z.strictObject({ action: z.literal(BulkActions.ASSIGN_TO_ME), ...bulkTarget }),
    z.strictObject({
      action: z.literal(BulkActions.ASSIGN_TO_AGENT),
      ...bulkTarget,
      params: z.strictObject({ userId: uuidSchema })
    }),
    z.strictObject({
      action: z.literal(BulkActions.ROUND_ROBIN_TO_TEAM),
      ...bulkTarget,
      params: z.strictObject({
        userIds: z
          .array(uuidSchema.transform(id => id.toLowerCase()))
          .min(RoutingLimits.MIN_USERS_FOR_ROUND_ROBIN)
          .max(RoutingLimits.MAX_USERS_PER_ACTION)
          .refine(ids => new Set(ids).size === ids.length, { message: 'a person is listed once' })
      })
    }),
    z.strictObject({ action: z.literal(BulkActions.UNASSIGN), ...bulkTarget }),
    z.strictObject({
      action: z.literal(BulkActions.SET_STATUS),
      ...bulkTarget,
      // Archiving is its own action and snoozing needs a moment; spam is a decision for one conversation
      params: z.strictObject({
        status: z.enum([
          ConversationStatus.OPEN,
          ConversationStatus.PENDING,
          ConversationStatus.RESOLVED
        ])
      })
    }),
    z.strictObject({
      action: z.literal(BulkActions.ADD_TAG),
      ...bulkTarget,
      params: z.strictObject({ tagId: uuidSchema })
    }),
    z.strictObject({
      action: z.literal(BulkActions.REMOVE_TAG),
      ...bulkTarget,
      params: z.strictObject({ tagId: uuidSchema })
    }),
    z.strictObject({ action: z.literal(BulkActions.MARK_READ), ...bulkTarget }),
    z.strictObject({ action: z.literal(BulkActions.MARK_UNREAD), ...bulkTarget }),
    z.strictObject({ action: z.literal(BulkActions.ARCHIVE), ...bulkTarget }),
    z.strictObject({ action: z.literal(BulkActions.EXPORT_CSV), ...bulkTarget })
  ])
  .refine(body => (body.conversationIds === undefined) !== (body.filter === undefined), {
    message: 'name the conversations or a filter, not both and not neither'
  })

export type ListConversationsQuery = z.output<typeof listConversationsQuerySchema>
export type ChangeStatusBody = z.output<typeof changeStatusSchema>
export type AssignBody = z.output<typeof assignSchema>
export type SnoozeBody = z.output<typeof snoozeSchema>
export type AttachTagBody = z.output<typeof attachTagSchema>
export type ConversationFilter = z.output<typeof conversationFilterSchema>
export type BulkActionBody = z.output<typeof bulkActionSchema>
