import { z } from 'zod'

import { AuthorType, idempotencyKeySchema, MessageType, uuidSchema } from '@platform/core/domain'

import {
  mediaMessageFields,
  messageContentSchema,
  type CreateMessageBody
} from './messages.schemas'
import { cleanNickname, type PluginMessageOrigin } from './plugin-message-origin'

// A bound on what is read before the nickname is cut, so that the work stays bounded
const NICKNAME_INPUT_MAX = 256

// What a plugin calls the kinds it may write: a reply (`MessageType.TEXT`), an internal note, and a file or an album with its text
// (`MessageType.IMAGE`, `VIDEO`, `AUDIO` and `DOCUMENT`, named as the human route names them). A template is not here: see
// `POST /plugin-api/messages` below.
export const PluginMessageTypes = {
  TEXT: 'text',
  NOTE: 'note',
  IMAGE: 'image',
  VIDEO: 'video',
  AUDIO: 'audio',
  DOCUMENT: 'document'
} as const

// The kinds of file, by what the plugin calls them: the type of the message the service stores
const FILE_TYPES = {
  [PluginMessageTypes.IMAGE]: MessageType.IMAGE,
  [PluginMessageTypes.VIDEO]: MessageType.VIDEO,
  [PluginMessageTypes.AUDIO]: MessageType.AUDIO,
  [PluginMessageTypes.DOCUMENT]: MessageType.DOCUMENT
} as const

// Who the message is from and how it behaves, the same for every kind
const authorFields = {
  authorType: z.enum([AuthorType.SYSTEM, AuthorType.AGENT]).default(AuthorType.SYSTEM),
  userId: uuidSchema.transform(id => id.toLowerCase()).optional(),
  quiet: z.boolean().default(false),
  nickname: z.string().max(NICKNAME_INPUT_MAX).optional()
}

// What a plugin may send to `POST /plugin-api/messages` (TDD_10 §6.4). Strict: a field this schema does not name is a 400, so a
// plugin cannot reach a field of the human route (a mention, a template) nor invent one (an avatar that is a remote url: the
// avatar of a plugin is its own icon, never a link it gives).
//   - `type`: a reply (`text`), an internal note (`note`), or a file with its text (`image`, `video`, `audio`, `document`). The files
//     are the ones THIS installation uploaded (`POST /plugin-api/media/upload-url` and `confirm-upload`, scope `media:write`): the
//     service checks the owner, the type, the size, the scan and the channel as it does for a person, and a file of another
//     installation, of a person or of another store is a 404. Several files make an album, as for a person (`mediaIds`, `captions`).
//     A template is not taken here: its permission (`messages:send_template`) comes from `channels:read`, which this route does not
//     name (it is a route of its own, PR E7-3, see the plan).
//   - `authorType`: `system` (the default) or `agent`; `agent` needs `userId`, and a `system` message carries none.
//   - `quiet`: the customer gets it and the thread shows it, the conversation does not change.
//   - `nickname`: only for `system`; cut and cleaned by `cleanNickname`, the name of the plugin when nothing is left.
//   - `idempotencyKey` is required for every kind: a plugin retries, and a retry must not write twice.
const fileMessage = (type: keyof typeof FILE_TYPES) =>
  z.strictObject({ type: z.literal(type), ...mediaMessageFields, ...authorFields })

export const pluginCreateMessageSchema = z
  .discriminatedUnion('type', [
    z.strictObject({
      type: z.literal(PluginMessageTypes.TEXT),
      conversationId: uuidSchema,
      content: messageContentSchema,
      idempotencyKey: idempotencyKeySchema,
      replyToMessageId: uuidSchema.optional(),
      // The file of an album that a reply quotes
      replyToMediaId: uuidSchema.optional(),
      ...authorFields
    }),
    z.strictObject({
      type: z.literal(PluginMessageTypes.NOTE),
      conversationId: uuidSchema,
      content: messageContentSchema,
      idempotencyKey: idempotencyKeySchema,
      replyToMessageId: uuidSchema.optional(),
      ...authorFields
    }),
    fileMessage(PluginMessageTypes.IMAGE),
    fileMessage(PluginMessageTypes.VIDEO),
    fileMessage(PluginMessageTypes.AUDIO),
    fileMessage(PluginMessageTypes.DOCUMENT)
  ])
  .superRefine((value, context) => {
    if (value.authorType === AuthorType.AGENT && value.userId === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['userId'],
        message: 'an agent message needs userId'
      })
    }
    if (value.authorType === AuthorType.SYSTEM && value.userId !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['userId'],
        message: 'userId is only for an agent message'
      })
    }
    if (value.authorType === AuthorType.AGENT && value.nickname !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['nickname'],
        message:
          'the nickname is only for a system message: an agent message carries the name of the person'
      })
    }
  })

export type PluginCreateMessageBody = z.infer<typeof pluginCreateMessageSchema>

// The body the service takes and the origin it needs, for the plugin that holds the key (its name is the nickname by default).
// `uploaderId` is who owns the files this installation uploaded (`plugin:<installation id>`): the service sends only files whose owner it is.
export function pluginMessageOf(
  body: PluginCreateMessageBody,
  plugin: { id: string; name: string; uploaderId: string }
): { body: CreateMessageBody; origin: PluginMessageOrigin } {
  const common = {
    conversationId: body.conversationId,
    idempotencyKey: body.idempotencyKey
  }
  const quote =
    body.replyToMessageId === undefined ? {} : { replyToMessageId: body.replyToMessageId }
  let message: CreateMessageBody
  switch (body.type) {
    case PluginMessageTypes.NOTE:
      message = {
        type: MessageType.INTERNAL_NOTE,
        ...common,
        content: body.content,
        ...quote,
        mentions: []
      }
      break
    case PluginMessageTypes.TEXT:
      message = {
        type: MessageType.TEXT,
        ...common,
        content: body.content,
        ...quote,
        ...(body.replyToMediaId === undefined ? {} : { replyToMediaId: body.replyToMediaId })
      }
      break
    default:
      message = {
        type: FILE_TYPES[body.type],
        ...common,
        mediaIds: body.mediaIds,
        ...(body.content === undefined ? {} : { content: body.content }),
        ...(body.captions === undefined ? {} : { captions: body.captions }),
        ...quote,
        ...(body.replyToMediaId === undefined ? {} : { replyToMediaId: body.replyToMediaId })
      }
  }
  const origin: PluginMessageOrigin =
    body.authorType === AuthorType.AGENT && body.userId !== undefined
      ? {
          pluginId: plugin.id,
          uploaderId: plugin.uploaderId,
          quiet: body.quiet,
          author: AuthorType.AGENT,
          userId: body.userId
        }
      : {
          pluginId: plugin.id,
          uploaderId: plugin.uploaderId,
          quiet: body.quiet,
          author: AuthorType.SYSTEM,
          // The name of the plugin when the plugin chose none (or nothing was left of what it chose)
          nickname: cleanNickname(body.nickname) ?? cleanNickname(plugin.name)
        }
  return { body: message, origin }
}
