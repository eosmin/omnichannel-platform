import { z } from 'zod'

import {
  InboundLimits,
  isWholeEmoji,
  idempotencyKeySchema,
  MessageLimits,
  MessageType,
  MisleadingTextPattern,
  PaginationLimits,
  uuidSchema
} from '@platform/core/domain'

import { messageCursorSchema } from './message-cursor'

// The text goes to the customer with its line breaks; only the ends are trimmed. The limit counts
// characters, as the channels do, and not the UTF-16 units of the string (an emoji is two). Postgres
// text cannot hold a NUL character: it is a 400 here and not a 500 there.
const content = z
  .string()
  .trim()
  .min(1)
  // Bounds the work of the count below: no text of 4096 characters needs more units than this
  .max(MessageLimits.CONTENT_MAX_LENGTH * 2)
  .refine(value => Array.from(value).length <= MessageLimits.CONTENT_MAX_LENGTH, {
    message: `at most ${MessageLimits.CONTENT_MAX_LENGTH} characters`
  })
  .refine(value => !value.includes('\0'), { message: 'contains a NUL character' })
  // A lone surrogate is not text: Postgres would refuse it or replace it
  .refine(value => !/\p{Surrogate}/u.test(value), { message: 'is not well-formed text' })

// A uuid has one spelling in the row: the same person in capitals is the same person
const mentions = z
  .array(uuidSchema.transform(id => id.toLowerCase()))
  .max(MessageLimits.MAX_MENTIONS)
  .refine(ids => new Set(ids).size === ids.length, { message: 'a person is mentioned once' })

// A reply to the customer must be sent once, so its key is required; a note reaches nobody outside
// the team and its key only protects a retry
// The variables of a template are the values of its numbered placeholders, in order. They go to the
// customer, so they are text like any other: no NUL, no lone surrogate.
const templateVariable = z
  .string()
  .trim()
  .min(1)
  .max(MessageLimits.TEMPLATE_VARIABLE_MAX_LENGTH)
  .refine(value => !value.includes('\0'), { message: 'contains a NUL character' })
  .refine(value => !/\p{Surrogate}/u.test(value), { message: 'is not well-formed text' })
  // Characters that reorder or hide text reach the customer as they are written
  .refine(value => !MisleadingTextPattern.test(value), {
    message: 'has characters that reorder or hide text'
  })
  // The provider refuses a parameter with a line break, a tab or four spaces in a row: better a 400
  // now than a message that fails on its way
  .refine(value => !/[\n\r\t]| {4}/.test(value), {
    message: 'has a line break, a tab or four spaces in a row'
  })

export const createMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal(MessageType.TEXT),
    conversationId: uuidSchema,
    content,
    idempotencyKey: idempotencyKeySchema,
    replyToMessageId: uuidSchema.optional()
  }),
  // The only way to write to a customer whose messaging window is closed
  z.strictObject({
    type: z.literal(MessageType.TEMPLATE),
    conversationId: uuidSchema,
    templateName: z.string().trim().min(1).max(MessageLimits.TEMPLATE_NAME_MAX_LENGTH),
    language: z.string().trim().min(1).max(MessageLimits.TEMPLATE_LANGUAGE_MAX_LENGTH),
    variables: z.array(templateVariable).max(MessageLimits.TEMPLATE_MAX_VARIABLES).default([]),
    idempotencyKey: idempotencyKeySchema
  }),
  z.strictObject({
    type: z.literal(MessageType.INTERNAL_NOTE),
    conversationId: uuidSchema,
    content,
    idempotencyKey: idempotencyKeySchema.optional(),
    replyToMessageId: uuidSchema.optional(),
    mentions: mentions.default([])
  })
])

export const listMessagesQuerySchema = z.strictObject({
  cursor: messageCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(PaginationLimits.MAX).default(PaginationLimits.DEFAULT)
})

// A null emoji takes the agent's reaction back
export const reactToMessageSchema = z.strictObject({
  emoji: z
    .string()
    .max(InboundLimits.EMOJI_MAX_LENGTH)
    .refine(value => isWholeEmoji(value, InboundLimits.EMOJI_MAX_LENGTH), {
      message: 'is not a whole emoji'
    })
    .nullable()
})

// The whole new text. A note also carries the `version` it was read at: an edit of a note that someone
// changed since is refused, so that nobody overwrites what they did not see. An edit of a message sent
// to the customer needs none: it is the author's own.
export const editMessageSchema = z.strictObject({
  content,
  version: z.number().int().min(1).optional()
})

export type EditMessageBody = z.output<typeof editMessageSchema>
export type ReactToMessageBody = z.output<typeof reactToMessageSchema>
export type CreateMessageBody = z.output<typeof createMessageSchema>
export type ListMessagesQuery = z.output<typeof listMessagesQuerySchema>
