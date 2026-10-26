import { z } from 'zod'

import {
  ChannelType,
  ConversationAssignedFilters,
  ConversationLimits,
  ConversationStatus,
  PaginationLimits,
  uuidSchema
} from '@platform/core/domain'

import { conversationCursorSchema } from './conversation-cursor'

export const idSchema = uuidSchema

const assigned = z.union([
  z.literal(ConversationAssignedFilters.ME),
  z.literal(ConversationAssignedFilters.UNASSIGNED),
  uuidSchema
])

// A query string carries text: only the two words are a boolean
const flag = z.enum(['true', 'false']).transform(value => value === 'true')

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
    channelType: z.enum(ChannelType).optional(),
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
      .optional()
  })
  .refine(
    body => body.resolutionReason === undefined || body.status === ConversationStatus.RESOLVED,
    {
      message: 'a resolution reason goes with resolving'
    }
  )

export const assignSchema = z.strictObject({ userId: uuidSchema.nullable() })

export const snoozeSchema = z.strictObject({
  until: z.iso.datetime({ offset: true }).transform(value => new Date(value))
})

export const attachTagSchema = z.strictObject({ tagId: uuidSchema })

export type ListConversationsQuery = z.output<typeof listConversationsQuerySchema>
export type ChangeStatusBody = z.output<typeof changeStatusSchema>
export type AssignBody = z.output<typeof assignSchema>
export type SnoozeBody = z.output<typeof snoozeSchema>
export type AttachTagBody = z.output<typeof attachTagSchema>
