import { z } from 'zod'

import { ChannelConnectionLimits, InboundLimits } from '@platform/core/domain'

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
  // What the client may send it may get back, unchanged: the same bound, on the plain JSON
  credentials: boundedJson(z.record(z.string(), z.unknown())),
  metadata: boundedJson(z.record(z.string(), z.json()))
})
export type ConnectResult = z.output<typeof connectResultSchema>
