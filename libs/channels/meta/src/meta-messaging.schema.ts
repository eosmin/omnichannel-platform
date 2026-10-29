import { z } from 'zod'

import { httpUrl, InboundLimits, MetaMessaging } from '@platform/core/domain'

const boundedId = z.string().min(1).max(InboundLimits.ID_MAX_LENGTH)
// A page-scoped or Instagram-scoped id: digits, and it goes into the path of a send
const scopedId = z.string().regex(MetaMessaging.RECIPIENT_ID_PATTERN)
// Milliseconds since the epoch. Bounded so that the date it makes is always valid.
const epochMillis = z.number().int().min(0).max(MetaMessaging.MAX_EPOCH_MS)

// A part that does not have the shape is the same as a part that is not there: the message keeps what
// identifies it (sender, id, time) and the plugin marks it, instead of losing what the customer wrote
const tolerant = <T extends z.ZodType>(schema: T): z.ZodCatch<z.ZodOptional<T>> =>
  schema.optional().catch(undefined)

const optionalText = z.string().optional().catch(undefined)
const optionalUrl = httpUrl(InboundLimits.MEDIA_REF_MAX_LENGTH).optional().catch(undefined)

export const metaAttachmentSchema = z.object({
  type: z.string().min(1),
  payload: tolerant(z.object({ url: optionalUrl }))
})

// What a Click-to-Message ad sends with the first message. Every part is read alone; the raw
// referral is kept for what the first real ad teaches.
export const metaReferralSchema = z.object({
  ref: optionalText,
  ad_id: boundedId.optional().catch(undefined),
  source: optionalText,
  type: optionalText,
  ads_context_data: tolerant(
    z.object({
      ad_title: optionalText,
      photo_url: optionalUrl,
      video_url: optionalUrl
    })
  )
})

export type MetaReferral = z.infer<typeof metaReferralSchema>

const rawReferral = tolerant(z.record(z.string(), z.unknown()))

export const metaMessageSchema = z.object({
  mid: boundedId,
  text: optionalText,
  attachments: tolerant(z.array(z.unknown())),
  reply_to: tolerant(z.object({ mid: z.string() })),
  // The page or account itself wrote it, in this app or in its own inbox
  is_echo: tolerant(z.boolean()),
  // The customer took it back; there is nothing new to store
  is_deleted: tolerant(z.boolean()),
  is_unsupported: tolerant(z.boolean()),
  referral: rawReferral
})

export type MetaMessage = z.infer<typeof metaMessageSchema>

// The customer edited a message (Messenger `message_edits`). The shape is taken from Meta's reference
// as read on 2026-10-29 and has not been seen in a real payload yet.
export const metaMessageEditSchema = z.object({
  mid: boundedId,
  text: optionalText,
  num_edit: tolerant(z.number().int().min(0))
})

export type MetaMessageEdit = z.infer<typeof metaMessageEditSchema>

export const metaReactionSchema = z.object({
  action: z.string(),
  emoji: optionalText,
  mid: z.string()
})

export const metaMessagingItemSchema = z.object({
  sender: z.object({ id: scopedId }),
  recipient: z.object({ id: scopedId }),
  timestamp: epochMillis,
  message: tolerant(metaMessageSchema),
  reaction: tolerant(metaReactionSchema),
  message_edit: tolerant(metaMessageEditSchema),
  referral: rawReferral
})

export type MetaMessagingItem = z.infer<typeof metaMessagingItemSchema>

// The envelope is strict and its items are not: a batch holds many events and one that does not fit
// must cost only itself (Meta does not send them again)
export const metaWebhookSchema = z.object({
  object: z.string(),
  entry: z.array(z.unknown())
})

const entrySchema = z.object({ id: scopedId, messaging: z.array(z.unknown()) })

export function parseMessagingEntry(entry: unknown): { id: string; messaging: unknown[] } | null {
  const parsed = entrySchema.safeParse(entry)
  return parsed.success ? parsed.data : null
}

export function parseMessagingItem(item: unknown): MetaMessagingItem | null {
  const parsed = metaMessagingItemSchema.safeParse(item)
  return parsed.success ? parsed.data : null
}
