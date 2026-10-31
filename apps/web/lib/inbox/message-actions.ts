import type { MessageView } from '@platform/api-client'
import { Permissions, type Permission } from '@platform/core/auth'
import { AuthorType, ChannelCapability, DeliveryStatus, MessageType } from '@platform/core/domain'

import { messageKindOf } from './thread-items'

// Who is asking and what the channel of the conversation can do. The interface only decides what to
// offer: the api checks every one of these again and answers with its own refusal.
export interface ActionViewer {
  userId: string | undefined
  can: (permission: Permission) => boolean
  capabilities: readonly string[]
}

export interface MessageActions {
  react: boolean
  edit: boolean
  remove: boolean
  resend: boolean
  // The kept text of a message the customer deleted
  viewDeleted: boolean
  // The earlier texts of an edited note
  revisions: boolean
}

const NONE: MessageActions = {
  react: false,
  edit: false,
  remove: false,
  resend: false,
  viewDeleted: false,
  revisions: false
}

// A reply that has a copy in the channel: the only kind a reaction, an edit or a delete can reach
const REACHED_THE_CHANNEL: readonly string[] = [
  DeliveryStatus.SENT,
  DeliveryStatus.DELIVERED,
  DeliveryStatus.READ
]

// What an agent may do to a message, by its kind, its author and the capabilities of its channel.
// The same rules as the api (`MessageChangesService`, `AgentReactionsService`, `resend`).
export function messageActionsOf(message: MessageView, viewer: ActionViewer): MessageActions {
  const kind = messageKindOf(message)
  if (kind === 'system' || kind === 'neutral') return NONE
  const supports = (capability: string): boolean => viewer.capabilities.includes(capability)
  const isNote = message.type === String(MessageType.INTERNAL_NOTE)
  const mayReadNotes = viewer.can(Permissions.MESSAGES_INTERNAL_NOTE)

  if (kind === 'deleted') {
    return {
      ...NONE,
      viewDeleted: viewer.can(Permissions.MESSAGES_VIEW_DELETED) && (!isNote || mayReadNotes)
    }
  }
  // A deletion on its way to the channel: nothing else is asked of the message until it settles
  if (message.deleteStatus === String(DeliveryStatus.QUEUED)) return NONE

  const isOwn = viewer.userId !== undefined && message.authorId === viewer.userId
  if (isNote) {
    return {
      ...NONE,
      edit: mayReadNotes,
      remove: mayReadNotes && (isOwn || viewer.can(Permissions.MESSAGES_DELETE)),
      revisions: message.editedAt !== null && mayReadNotes && viewer.can(Permissions.MESSAGES_VIEW)
    }
  }

  const maySend = viewer.can(Permissions.MESSAGES_SEND)
  const isReplyOfTeam = message.authorType === String(AuthorType.AGENT)
  // A reply of the team or of a plugin has a copy in the channel only once it was sent; a message of
  // the customer or of the owner's own phone came from the channel
  const needsDelivery = isReplyOfTeam || message.authorType === String(AuthorType.SYSTEM)
  const reached =
    !needsDelivery ||
    (message.deliveryStatus !== null && REACHED_THE_CHANNEL.includes(message.deliveryStatus))
  const react = maySend && reached && supports(ChannelCapability.REACTIONS)
  if (!isReplyOfTeam) return { ...NONE, react }

  const isEditPending = message.pendingEdit
  return {
    ...NONE,
    react,
    edit:
      maySend &&
      isOwn &&
      reached &&
      !isEditPending &&
      message.type === String(MessageType.TEXT) &&
      supports(ChannelCapability.EDIT_MESSAGE),
    remove:
      ((maySend && isOwn) || viewer.can(Permissions.MESSAGES_DELETE)) &&
      reached &&
      !isEditPending &&
      supports(ChannelCapability.DELETE_MESSAGE),
    resend:
      message.deliveryStatus === String(DeliveryStatus.FAILED) &&
      viewer.can(
        message.type === String(MessageType.TEMPLATE)
          ? Permissions.MESSAGES_SEND_TEMPLATE
          : Permissions.MESSAGES_SEND
      )
  }
}

export const hasAnyAction = (actions: MessageActions): boolean =>
  Object.values(actions).some(Boolean)
