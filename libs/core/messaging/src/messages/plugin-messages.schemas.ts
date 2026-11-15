import { z } from 'zod'

import { AuthorType, idempotencyKeySchema, MessageType, uuidSchema } from '@platform/core/domain'

import { messageContentSchema, type CreateMessageBody } from './messages.schemas'
import { cleanNickname, type PluginMessageOrigin } from './plugin-message-origin'

// A bound on what is read before the nickname is cut, so that the work stays bounded
const NICKNAME_INPUT_MAX = 256

// What a plugin calls the two kinds it may write (`MessageType.TEXT` and `MessageType.INTERNAL_NOTE` inside)
export const PluginMessageTypes = {
  TEXT: 'text',
  NOTE: 'note'
} as const

// What a plugin may send to `POST /plugin-api/messages` (TDD_10 §6.4). Strict: a field this schema does not name is a 400, so a
// plugin cannot reach a field of the human route (a mention, a template) nor invent one (an avatar that is a remote url: the
// avatar of a plugin is its own icon, never a link it gives).
//   - `type`: a reply (`text`) or an internal note (`note`). Files and templates are not taken here (`MessagesService.create`
//     refuses them for a plugin; the media of a plugin is Step 5.6 PR E7).
//   - `authorType`: `system` (the default) or `agent`; `agent` needs `userId`, and a `system` message carries none.
//   - `quiet`: the customer gets it and the thread shows it, the conversation does not change.
//   - `nickname`: only for `system`; cut and cleaned by `cleanNickname`, the name of the plugin when nothing is left.
//   - `idempotencyKey` is required for both kinds: a plugin retries, and a retry must not write twice.
export const pluginCreateMessageSchema = z
  .strictObject({
    type: z.enum([PluginMessageTypes.TEXT, PluginMessageTypes.NOTE]),
    conversationId: uuidSchema,
    content: messageContentSchema,
    idempotencyKey: idempotencyKeySchema,
    replyToMessageId: uuidSchema.optional(),
    // The file of an album that a reply quotes; a note quotes a message, not a file of it
    replyToMediaId: uuidSchema.optional(),
    authorType: z.enum([AuthorType.SYSTEM, AuthorType.AGENT]).default(AuthorType.SYSTEM),
    userId: uuidSchema.transform(id => id.toLowerCase()).optional(),
    quiet: z.boolean().default(false),
    nickname: z.string().max(NICKNAME_INPUT_MAX).optional()
  })
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
    if (value.type === PluginMessageTypes.NOTE && value.replyToMediaId !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['replyToMediaId'],
        message: 'a note quotes a message, not a file of it'
      })
    }
  })

export type PluginCreateMessageBody = z.infer<typeof pluginCreateMessageSchema>

// The body the service takes and the origin it needs, for the plugin that holds the key (its name is the nickname by default)
export function pluginMessageOf(
  body: PluginCreateMessageBody,
  plugin: { id: string; name: string }
): { body: CreateMessageBody; origin: PluginMessageOrigin } {
  const common = {
    conversationId: body.conversationId,
    content: body.content,
    idempotencyKey: body.idempotencyKey
  }
  const message: CreateMessageBody =
    body.type === PluginMessageTypes.NOTE
      ? {
          type: MessageType.INTERNAL_NOTE,
          ...common,
          ...(body.replyToMessageId === undefined
            ? {}
            : { replyToMessageId: body.replyToMessageId }),
          mentions: []
        }
      : {
          type: MessageType.TEXT,
          ...common,
          ...(body.replyToMessageId === undefined
            ? {}
            : { replyToMessageId: body.replyToMessageId }),
          ...(body.replyToMediaId === undefined ? {} : { replyToMediaId: body.replyToMediaId })
        }
  const origin: PluginMessageOrigin =
    body.authorType === AuthorType.AGENT && body.userId !== undefined
      ? { pluginId: plugin.id, quiet: body.quiet, author: AuthorType.AGENT, userId: body.userId }
      : {
          pluginId: plugin.id,
          quiet: body.quiet,
          author: AuthorType.SYSTEM,
          // The name of the plugin when the plugin chose none (or nothing was left of what it chose)
          nickname: cleanNickname(body.nickname) ?? cleanNickname(plugin.name)
        }
  return { body: message, origin }
}
