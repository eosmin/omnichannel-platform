import { z } from 'zod'

import {
  httpUrl,
  InboundLimits,
  InboundMessageTypes,
  isWholeEmoji,
  MessageType,
  OriginKinds,
  OriginMediaTypes,
  ReactionActors
} from '@platform/core/domain'
import { ChannelEventTypes } from '@platform/plugins/sdk'

const id = z.string().min(1).max(InboundLimits.ID_MAX_LENGTH)
const text = (max: number): z.ZodString => z.string().max(max)

const metadata = z
  .record(z.string(), z.json())
  .refine(value => Buffer.byteLength(JSON.stringify(value)) <= InboundLimits.METADATA_MAX_BYTES, {
    message: 'metadata is too large'
  })

const media = z.strictObject({
  ref: z.string().min(1).max(InboundLimits.MEDIA_REF_MAX_LENGTH),
  contentType: z.string().min(1).max(InboundLimits.CONTENT_TYPE_MAX_LENGTH),
  filename: text(InboundLimits.FILENAME_MAX_LENGTH).nullable()
})

const url = httpUrl(InboundLimits.MEDIA_REF_MAX_LENGTH)

const origin = z.strictObject({
  kind: z.enum(OriginKinds),
  sourceId: id.optional(),
  sourceUrl: url.optional(),
  title: text(InboundLimits.ORIGIN_TITLE_MAX_LENGTH).optional(),
  body: text(InboundLimits.ORIGIN_BODY_MAX_LENGTH).optional(),
  media: z
    .strictObject({
      type: z.enum(OriginMediaTypes),
      ref: z.string().min(1).max(InboundLimits.MEDIA_REF_MAX_LENGTH).optional(),
      url: url.optional()
    })
    .refine(value => (value.ref === undefined) !== (value.url === undefined), {
      message: 'an origin media is a reference or a url, one of them'
    })
    .optional(),
  thumbnailUrl: url.optional(),
  clickId: id.optional(),
  referral: metadata.optional()
})

const message = z.strictObject({
  externalId: id,
  // A plugin says what the customer sent, not what only the platform writes (SYSTEM, INTERNAL_NOTE)
  type: z.enum(InboundMessageTypes),
  content: text(InboundLimits.CONTENT_MAX_LENGTH).nullable(),
  media: z.array(media).min(1).max(InboundLimits.MAX_MEDIA_PER_MESSAGE).optional(),
  origin: origin.optional(),
  replyToExternalId: id.optional(),
  metadata: metadata.optional(),
  timestamp: z.iso.datetime({ offset: true })
})

const status = z.strictObject({
  externalId: id,
  error: z.strictObject({ code: text(64), message: text(500) }).optional()
})

const reaction = z.strictObject({
  targetExternalId: id,
  // An emoji is a short string; null takes the reaction back
  emoji: z
    .string()
    .min(1)
    .max(InboundLimits.EMOJI_MAX_LENGTH)
    // Not blank, and nothing the database would refuse: a NUL, or half of an emoji
    .refine(value => isWholeEmoji(value, InboundLimits.EMOJI_MAX_LENGTH), {
      message: 'an emoji is visible and whole'
    })
    .nullable(),
  from: z.enum(ReactionActors).optional(),
  eventId: id.optional()
})

const edit = z.strictObject({
  targetExternalId: id,
  content: text(InboundLimits.CONTENT_MAX_LENGTH),
  from: z.enum(ReactionActors).optional(),
  eventId: id.optional()
})

const deletion = z.strictObject({
  targetExternalId: id,
  from: z.enum(ReactionActors).optional(),
  eventId: id.optional()
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
    reaction: reaction.optional(),
    edit: edit.optional(),
    deletion: deletion.optional(),
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
    const needsMessage: readonly string[] = [
      ChannelEventTypes.MESSAGE_RECEIVED,
      ChannelEventTypes.MESSAGE_ECHO
    ]
    if (needsMessage.includes(event.type) && event.message === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['message'],
        message: 'a received or echoed event needs its message'
      })
    }
    const isReaction = event.type === ChannelEventTypes.MESSAGE_REACTION
    if (isReaction !== (event.reaction !== undefined) || (isReaction && event.message)) {
      context.addIssue({
        code: 'custom',
        path: ['reaction'],
        message: 'only a reaction event has a reaction, and it has no message'
      })
    }
    const isEdit = event.type === ChannelEventTypes.MESSAGE_EDITED
    if (isEdit !== (event.edit !== undefined) || (isEdit && event.message)) {
      context.addIssue({
        code: 'custom',
        path: ['edit'],
        message: 'only an edit event has an edit, and it has no message'
      })
    }
    const isDeletion = event.type === ChannelEventTypes.MESSAGE_DELETED
    if (isDeletion !== (event.deletion !== undefined) || (isDeletion && event.message)) {
      context.addIssue({
        code: 'custom',
        path: ['deletion'],
        message: 'only a delete event has a deletion, and it has no message'
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
