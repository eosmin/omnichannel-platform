import { z } from 'zod'

import {
  ChannelConnectionLimits,
  ChannelConnectionListStates,
  InboundLimits,
  PaginationLimits,
  singleLineText
} from '@platform/core/domain'

import { cursorSchema } from '../customers/list-cursor'

// A value that fits the limit once written as JSON, and holds no NUL: Postgres refuses it in text and
// in jsonb, and that would be a 500 where the answer is a 400
const boundedJson = <T extends z.ZodType>(schema: T) =>
  schema.refine(
    value => {
      const json = JSON.stringify(value)
      return (
        Buffer.byteLength(json) <= ChannelConnectionLimits.MAX_JSON_BYTES &&
        !json.includes('\\u0000')
      )
    },
    { message: 'too large, or it holds a NUL character' }
  )

// What the client sends to connect a channel: whatever the plugin needs (a token, a phone number id).
// The plugin checks its own shape; the platform only bounds the size.
export const connectChannelSchema = z.strictObject({
  credentials: boundedJson(z.record(z.string(), z.unknown()))
})
export type ConnectChannelBody = z.output<typeof connectChannelSchema>

// The name the owner gives to a connection: one visible line, cut to a short length, or null to go back to
// the name of the account. Nothing else is accepted, so the body cannot reach any other column.
export const renameConnectionSchema = z.strictObject({
  label: singleLineText(ChannelConnectionLimits.LABEL_MAX_LENGTH, 1).nullable()
})
export type RenameConnectionBody = z.output<typeof renameConnectionSchema>

// What a plugin answers to connect(): checked before it is stored or shown. The credentials it returns
// may differ from the input (an exchanged long-lived token) and are what is kept.
export const connectResultSchema = z.object({
  connectionId: z
    .string()
    .min(1)
    .max(InboundLimits.ID_MAX_LENGTH)
    // eslint-disable-next-line no-control-regex -- the point is to refuse them
    .regex(/^[^\u0000-\u001f\u007f]+$/),
  displayName: z.string().min(1).max(ChannelConnectionLimits.DISPLAY_NAME_MAX_LENGTH),
  displayNameIsPlaceholder: z.boolean().optional(),
  // What the client may send it may get back, unchanged: the same bound, on the plain JSON
  credentials: boundedJson(z.record(z.string(), z.unknown())),
  metadata: boundedJson(z.record(z.string(), z.json()))
})
export type ConnectResult = z.output<typeof connectResultSchema>

// One page of the connections of the store. `state` narrows the list to the ones in use or the ones
// disconnected; without it both come, in order of creation. A cursor that is not ours, or a
// limit out of range, is a malformed query (400), not an empty page.
export const listConnectionsQuerySchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(PaginationLimits.MAX).default(PaginationLimits.DEFAULT),
  state: z.enum(ChannelConnectionListStates).optional()
})
export type ListConnectionsQuery = z.output<typeof listConnectionsQuerySchema>
