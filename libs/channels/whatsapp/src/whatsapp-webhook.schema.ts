import { z } from 'zod'

import { InboundLimits, WhatsAppWebhook } from '@platform/core/domain'

// Ids that become the externalId or the media reference: what the core would refuse is skipped here
const messageId = z.string().min(1).max(InboundLimits.ID_MAX_LENGTH)
// A unix time in seconds, as text. Bounded so that the date it makes is always valid.
const unixSeconds = z.string().regex(/^\d{1,12}$/)

// A part of a message that does not have the shape is the same as a part that is not there: the
// message then keeps what identifies it (sender, id, time, type) and the plugin marks it, instead of
// losing what the customer wrote
const tolerant = <T extends z.ZodType>(schema: T): z.ZodCatch<z.ZodOptional<T>> =>
  schema.optional().catch(undefined)

// A coordinate is a number or text that holds one; an empty text is not zero, and Infinity is not a place
const coordinate = (limit: number) =>
  z
    .union([z.number(), z.string().trim().min(1).transform(Number)])
    .pipe(z.number().finite().min(-limit).max(limit))

const mediaSchema = z.object({
  id: z.string().min(1).max(InboundLimits.MEDIA_REF_MAX_LENGTH),
  // Optional and odd is the same as absent: the customer's file matters more than its label
  mime_type: z.string().min(1).optional().catch(undefined),
  caption: z.string().optional().catch(undefined),
  filename: z.string().optional().catch(undefined)
})

export const whatsAppMessageSchema = z.object({
  // The phone and the user id: today both arrive; a customer with a username brings only the user id
  from: messageId.optional(),
  from_user_id: messageId.optional(),
  id: messageId,
  timestamp: unixSeconds,
  type: z.string().min(1),
  context: tolerant(z.object({ id: z.string().optional() })),
  text: tolerant(z.object({ body: z.string() })),
  image: tolerant(mediaSchema),
  video: tolerant(mediaSchema),
  audio: tolerant(mediaSchema),
  document: tolerant(mediaSchema),
  sticker: tolerant(mediaSchema),
  location: tolerant(
    z.object({
      latitude: coordinate(90),
      longitude: coordinate(180),
      name: z.string().optional().catch(undefined),
      address: z.string().optional().catch(undefined)
    })
  ),
  interactive: tolerant(
    z.object({
      type: z.string(),
      button_reply: tolerant(z.object({ id: z.string(), title: z.string() })),
      list_reply: tolerant(z.object({ id: z.string(), title: z.string() }))
    })
  ),
  button: tolerant(z.object({ text: z.string(), payload: z.string().optional() }))
})

export type WhatsAppMessage = z.infer<typeof whatsAppMessageSchema>

const errorSchema = z.object({
  code: z.union([z.number(), z.string()]).catch('unknown'),
  title: z.string().optional().catch(undefined),
  message: z.string().optional().catch(undefined)
})

export const whatsAppStatusSchema = z.object({
  id: messageId,
  recipient_id: messageId.optional(),
  recipient_user_id: messageId.optional(),
  status: z.string().min(1),
  timestamp: unixSeconds,
  errors: z.array(errorSchema).optional().catch(undefined)
})

export type WhatsAppStatus = z.infer<typeof whatsAppStatusSchema>

export const whatsAppContactSchema = z.object({
  wa_id: z.string().optional(),
  user_id: z.string().optional(),
  profile: z.object({ name: z.string() }).optional()
})

// The envelope is strict and its items are not: a batch holds many messages and statuses, and one
// that does not fit must cost only itself, not the ones beside it (Meta does not send them again).
const changeValueSchema = z.object({
  metadata: z.object({ phone_number_id: messageId }),
  contacts: z.array(z.unknown()).optional(),
  messages: z.array(z.unknown()).optional(),
  statuses: z.array(z.unknown()).optional()
})

// Entries and changes are read one by one, like messages: the envelope only says it is ours
export const whatsAppWebhookSchema = z.object({
  object: z.literal(WhatsAppWebhook.OBJECT),
  entry: z.array(z.unknown())
})

const entrySchema = z.object({ changes: z.array(z.unknown()) })
const changeSchema = z.object({ field: z.string(), value: z.unknown() })

export function parseEntryChanges(entry: unknown): { field: string; value: unknown }[] {
  const parsed = entrySchema.safeParse(entry)
  if (!parsed.success) return []
  return parsed.data.changes.flatMap(change => {
    const result = changeSchema.safeParse(change)
    return result.success ? [result.data] : []
  })
}

export type WhatsAppChangeValue = z.infer<typeof changeValueSchema>

export function parseChangeValue(value: unknown): WhatsAppChangeValue | null {
  const parsed = changeValueSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
