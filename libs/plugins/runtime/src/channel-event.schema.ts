import { z } from 'zod'

import { InboundLimits, InboundMessageTypes, MessageType } from '@platform/core/domain'
import { ChannelEventTypes } from '@platform/plugins/sdk'

const id = z.string().min(1).max(InboundLimits.ID_MAX_LENGTH)
const text = (max: number): z.ZodString => z.string().max(max)

const metadata = z
  .record(z.string(), z.json())
  .refine(value => Buffer.byteLength(JSON.stringify(value)) <= InboundLimits.METADATA_MAX_BYTES, {
    message: 'metadata is too large'
  })

const message = z.strictObject({
  externalId: id,
  // A plugin says what the customer sent, not what only the platform writes (SYSTEM, INTERNAL_NOTE)
  type: z.enum(InboundMessageTypes),
  content: text(InboundLimits.CONTENT_MAX_LENGTH).nullable(),
  media: z
    .strictObject({
      ref: z.string().min(1).max(InboundLimits.MEDIA_REF_MAX_LENGTH),
      contentType: z.string().min(1).max(InboundLimits.CONTENT_TYPE_MAX_LENGTH),
      filename: text(InboundLimits.FILENAME_MAX_LENGTH).nullable()
    })
    .optional(),
  replyToExternalId: id.optional(),
  metadata: metadata.optional(),
  timestamp: z.iso.datetime({ offset: true })
})

const status = z.strictObject({
  externalId: id,
  error: z.strictObject({ code: text(64), message: text(500) }).optional()
})

// What a channel plugin returns for an event, checked before anything uses it: the plugin may be a
// third party's, and a provider's payload is not ours either. A field that is not here is refused.
export const channelEventSchema = z
  .strictObject({
    type: z.enum(ChannelEventTypes),
    connectionId: id,
    channelIdentity: id,
    channelProfile: z
      .strictObject({
        displayName: text(200).optional(),
        avatarUrl: z.url().max(InboundLimits.MEDIA_REF_MAX_LENGTH).optional(),
        locale: text(35).optional()
      })
      .optional(),
    message: message.optional(),
    status: status.optional(),
    messageId: z.uuid().optional(),
    timestamp: z.iso.datetime({ offset: true })
  })
  .superRefine((event, context) => {
    const sent = event.message
    if (sent !== undefined) {
      const mediaTypes: readonly string[] = [
        MessageType.IMAGE,
        MessageType.VIDEO,
        MessageType.AUDIO,
        MessageType.DOCUMENT
      ]
      const needsMedia = mediaTypes.includes(sent.type)
      if (needsMedia !== (sent.media !== undefined)) {
        context.addIssue({
          code: 'custom',
          path: ['message', 'media'],
          message: needsMedia ? 'a media message needs its media' : 'only a media message has media'
        })
      }
      if (sent.type === MessageType.TEXT && (sent.content ?? '').trim() === '') {
        context.addIssue({
          code: 'custom',
          path: ['message', 'content'],
          message: 'a text message has text'
        })
      }
    }
    if (event.type === ChannelEventTypes.MESSAGE_RECEIVED && event.message === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['message'],
        message: 'a received event needs its message'
      })
    }
    const needsStatus: readonly string[] = [
      ChannelEventTypes.MESSAGE_DELIVERED,
      ChannelEventTypes.MESSAGE_READ,
      ChannelEventTypes.MESSAGE_FAILED
    ]
    if (needsStatus.includes(event.type) && event.status === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'a status event needs its status'
      })
    }
  })

export type ValidChannelEvent = z.output<typeof channelEventSchema>
