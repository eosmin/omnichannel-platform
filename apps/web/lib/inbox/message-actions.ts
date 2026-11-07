import type { MessageView } from '@platform/api-client'
import { ClientPermissions, type Permission } from '@platform/core/auth'
import {
  AuthorType,
  CaptionState,
  ChannelCapability,
  DeliveryStatus,
  MessageType
} from '@platform/core/domain'

import { failureStateOf } from './failure-state'
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
  // Answer this message: it is quoted in the reply, in the channels that quote
  reply: boolean
  edit: boolean
  remove: boolean
  resend: boolean
  // A reply known not to have gone out can be given up (the api checks it again)
  discard: boolean
  // Only the text under a file, sent again: drawn in the bubble beside the notice, not in the menu
  resendCaption: boolean
  // A file of the customer that was lost, downloaded again: drawn in the bubble beside the line that says so
  refetchFile: boolean
  // The kept text of a message the customer deleted
  viewDeleted: boolean
  // The earlier texts of an edited note
  revisions: boolean
}

const NONE: MessageActions = {
  react: false,
  reply: false,
  edit: false,
  remove: false,
  resend: false,
  discard: false,
  resendCaption: false,
  refetchFile: false,
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
  const mayReadNotes = viewer.can(ClientPermissions.MESSAGES_INTERNAL_NOTE)

  if (kind === 'deleted') {
    return {
      ...NONE,
      viewDeleted: viewer.can(ClientPermissions.MESSAGES_VIEW_DELETED) && (!isNote || mayReadNotes)
    }
  }
  // A deletion on its way to the channel: nothing else is asked of the message until it settles
  if (message.deleteStatus === String(DeliveryStatus.QUEUED)) return NONE

  const isOwn = viewer.userId !== undefined && message.authorId === viewer.userId
  if (isNote) {
    return {
      ...NONE,
      edit: mayReadNotes,
      remove: mayReadNotes && (isOwn || viewer.can(ClientPermissions.MESSAGES_DELETE)),
      revisions:
        message.editedAt !== null && mayReadNotes && viewer.can(ClientPermissions.MESSAGES_VIEW)
    }
  }

  const maySend = viewer.can(ClientPermissions.MESSAGES_SEND)
  const isReplyOfTeam = message.authorType === String(AuthorType.AGENT)
  // A reply of the team or of a plugin has a copy in the channel only once it was sent; a message of
  // the customer or of the owner's own phone came from the channel
  const needsDelivery = isReplyOfTeam || message.authorType === String(AuthorType.SYSTEM)
  const reached =
    !needsDelivery ||
    (message.deliveryStatus !== null && REACHED_THE_CHANNEL.includes(message.deliveryStatus))
  const react = maySend && reached && supports(ChannelCapability.REACTIONS)
  // Only a message the channel has can be quoted in it
  const reply = maySend && reached && supports(ChannelCapability.REPLY_TO)
  if (!isReplyOfTeam) {
    return {
      ...NONE,
      react,
      reply,
      refetchFile: maySend && message.authorType === String(AuthorType.CUSTOMER)
    }
  }

  const mayResend =
    message.deliveryStatus === String(DeliveryStatus.FAILED) &&
    viewer.can(
      message.type === String(MessageType.TEMPLATE)
        ? ClientPermissions.MESSAGES_SEND_TEMPLATE
        : ClientPermissions.MESSAGES_SEND
    )
  const isEditPending = message.pendingEdit
  // The text under a file is on its way: the message is left alone until it settles
  const isCaptionQueued = message.captionState === CaptionState.QUEUED
  return {
    ...NONE,
    react,
    reply,
    edit:
      maySend &&
      isOwn &&
      reached &&
      !isEditPending &&
      message.type === String(MessageType.TEXT) &&
      supports(ChannelCapability.EDIT_MESSAGE),
    remove:
      ((maySend && isOwn) || viewer.can(ClientPermissions.MESSAGES_DELETE)) &&
      reached &&
      !isEditPending &&
      !isCaptionQueued &&
      supports(ChannelCapability.DELETE_MESSAGE),
    resendCaption:
      maySend &&
      reached &&
      !isEditPending &&
      (message.captionState === CaptionState.FAILED ||
        message.captionState === CaptionState.UNCONFIRMED),
    resend: mayResend,
    // Only what is known not to have reached the customer: what may have gone out can be sent again
    // (with a warning) and never discarded, or the team would lose the trace of a message that was read
    discard: mayResend && failureStateOf(message) === 'definitive'
  }
}

// Whether the bar beside the bubble has anything to offer; the caption button lives in the bubble
export const hasAnyAction = (actions: MessageActions): boolean =>
  actions.react ||
  actions.reply ||
  actions.edit ||
  actions.remove ||
  actions.resend ||
  actions.discard ||
  actions.viewDeleted ||
  actions.revisions
