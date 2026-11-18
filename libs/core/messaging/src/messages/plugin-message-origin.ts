import type { Permission } from '@platform/core/auth'
import { AuthorType, MessageLimits, MessageType, placeTextOf } from '@platform/core/domain'

import { type Viewer, viewerOf } from '../conversations/conversations.support'

import type { MessageView } from './messages.views'

// A message that a plugin writes through its key (`POST /plugin-api/messages`, TDD_10 §6). The plugin is always on the
// trace (`Message.authorPluginId`); who the message is FROM is its own choice, and `quiet` is a separate one:
//   - `system`: the message is the system's. It never counts as a human answer, so `recordReply` does not set
//     `firstResponseAt` for it (the response time of the team never looks instant because a bot answered); it sets
//     `firstAutomatedResponseAt` instead. It shows the `nickname` the plugin chose.
//   - `agent`: the message is that person's, with their own name, and counts as their answer. The person is an active member
//     of the store who holds the permission the message needs; there is no `agent` without one.
//   - `quiet`: the customer gets the message and the thread shows it, but the conversation does not change at all.
// There is no author `customer`: a plugin cannot write as the customer.
export type PluginMessageOrigin = {
  pluginId: string
  // Who owns the files this installation uploaded (`plugin:<installation id>`): the files a message of the plugin may carry are those
  // and no others. Missing, a file is refused (there is nobody whose upload it could be).
  uploaderId?: string
  quiet: boolean
} & (
  | { author: AuthorType.SYSTEM; nickname: string | null }
  | { author: AuthorType.AGENT; userId: string }
)

// The viewer of a call that has no person: the permissions are the ones the scopes of the plugin stand for. The id is empty on
// purpose, so that it is never the assignee of a conversation (a plugin without `conversations:view-all` does not see the
// conversations assigned to someone) and is never written as an author: the author of a plugin message comes from the origin, and
// the author of an edit, a deletion or a reaction is the `pluginId` (the routes that change a message pass it; `actorOfViewer`).
export function pluginViewerOf(held: readonly Permission[], pluginId?: string): Viewer {
  return pluginId === undefined ? viewerOf('', held) : { ...viewerOf('', held), pluginId }
}

// The nickname a plugin chose for its messages, made safe to store and to show: the characters that reorder or hide text are
// removed, a control character becomes a space, the ends are trimmed and it is cut to the limit without splitting a character.
// Null when nothing is left (the plugin's own name is used then).
export function cleanNickname(nickname: string | undefined | null): string | null {
  return placeTextOf(nickname, MessageLimits.NICKNAME_MAX_LENGTH)
}

// What a plugin gets back of a message it wrote or sent again (HC-011), held to what its key may read. The route of a write names
// `messages:write` and `conversations:read`, so it cannot ask for `messages:read`: the controller asks the key, with what it holds.
//   - the quote (`replyTo`): without `messages:read` the plugin gets the id of the quoted message (`replyToMessageId`, which it sent)
//     and no detail, because the text of the message of a customer or of a person is a read of messages. With it, an allowlist of the
//     kind, the author type and the text, and none at all when the quoted message was deleted; never the text of an internal note (which `messages:write` would otherwise show,
//     because it grants writing notes), never a file and never the id of the member of the team who wrote it;
//   - the ids of the team that ride on the view (who reacted, who edited, who deleted, who was mentioned) are left out as well: a
//     plugin learns no id of the team (`PluginRevisionView` leaves `editedById` out for the same reason).
export function pluginMessageViewOf(message: MessageView, readsMessages: boolean): MessageView {
  const quote = message.replyTo
  return {
    ...message,
    replyTo:
      // A quote of a message that was deleted says nothing: not that it was deleted, nor who wrote it (HC-216)
      quote === null || !readsMessages || quote.deleted
        ? null
        : {
            id: quote.id,
            type: quote.type,
            authorType: quote.authorType,
            authorId: null,
            content: quote.type === MessageType.INTERNAL_NOTE ? null : quote.content,
            file: null,
            // A deleted quote never gets here: it is dropped above
            deleted: false
          },
    mentions: [],
    editedById: null,
    deletedById: null,
    // What the customers reacted is theirs to read (`messages:read`); who of the team reacted is never given
    reactions: readsMessages
      ? message.reactions.map(reaction =>
          reaction.authorType === AuthorType.AGENT ? { ...reaction, authorId: null } : reaction
        )
      : []
  }
}
