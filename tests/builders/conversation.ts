import { randomUUID } from 'node:crypto'

import type { OwnerClient } from '@platform/core/database-testing'
import {
  AuthorType,
  ChannelType,
  type ConversationStatus,
  MessageType
} from '@platform/core/domain'

import { createCustomerIdentity } from './customer'
import { ensurePluginInstallation } from './plugin'

export interface ConversationInput {
  storeId: string
  customerId: string
  customerIdentityId: string
  channelType: string
  status?: ConversationStatus
  assignedTo?: string | null
  lastMessageAt?: Date | null
  unreadCount?: number
  resolvedAt?: Date | null
  // Conversations that share a connection are cheaper to build in the thousands
  channelConnectionId?: string
}

// A connection of a channel in a store, as the owner bootstrap of a real one would leave it
export async function createChannelConnection(
  owner: OwnerClient,
  input: { storeId: string; channelType: string }
): Promise<{ id: string }> {
  const installation = await ensurePluginInstallation(owner, {
    storeId: input.storeId,
    pluginId: input.channelType
  })
  return owner.channelConnection.create({
    data: {
      storeId: input.storeId,
      pluginId: input.channelType,
      installationId: installation.id,
      connectionId: `conn-${randomUUID()}`,
      displayName: 'test connection',
      credentials: Buffer.from('not a secret')
    },
    select: { id: true }
  })
}

// A conversation of a customer through one of their identities, over a connection made for it
export async function createConversation(
  owner: OwnerClient,
  input: ConversationInput
): Promise<{ id: string }> {
  const connectionId =
    input.channelConnectionId ??
    (
      await createChannelConnection(owner, {
        storeId: input.storeId,
        channelType: input.channelType
      })
    ).id
  return owner.conversation.create({
    data: {
      storeId: input.storeId,
      customerId: input.customerId,
      customerIdentityId: input.customerIdentityId,
      channelConnectionId: connectionId,
      channelType: input.channelType,
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.assignedTo === undefined ? {} : { assignedTo: input.assignedTo }),
      ...(input.lastMessageAt === undefined ? {} : { lastMessageAt: input.lastMessageAt }),
      ...(input.unreadCount === undefined ? {} : { unreadCount: input.unreadCount }),
      ...(input.resolvedAt === undefined ? {} : { resolvedAt: input.resolvedAt })
    },
    select: { id: true }
  })
}

// A conversation with a customer and an identity of its own, for the suites that need only the row
export async function createConversationOf(
  owner: OwnerClient,
  input: Omit<ConversationInput, 'customerId' | 'customerIdentityId' | 'channelType'> & {
    channelType?: string
  }
): Promise<{ id: string; customerId: string; customerIdentityId: string }> {
  const channelType = input.channelType ?? ChannelType.INSTAGRAM
  const identity = await createCustomerIdentity(owner, { storeId: input.storeId, channelType })
  const conversation = await createConversation(owner, {
    ...input,
    customerId: identity.customerId,
    customerIdentityId: identity.id,
    channelType
  })
  return { id: conversation.id, customerId: identity.customerId, customerIdentityId: identity.id }
}

export async function createMessage(
  owner: OwnerClient,
  input: {
    storeId: string
    conversationId: string
    content?: string
    authorType?: AuthorType
    type?: MessageType
    createdAt?: Date
    metadata?: Record<string, string>
  }
): Promise<{ id: string }> {
  return owner.message.create({
    data: {
      storeId: input.storeId,
      conversationId: input.conversationId,
      type: input.type ?? MessageType.TEXT,
      content: input.content ?? 'hello',
      // A note is written by the team: the api never makes one with another author
      authorType:
        input.authorType ??
        (input.type === MessageType.INTERNAL_NOTE ? AuthorType.AGENT : AuthorType.CUSTOMER),
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata })
    },
    select: { id: true }
  })
}

// Remembers the conversation of each message: the routes that reach a message name its conversation
export const conversationOfMessage = new Map<string, string>()

// A message in a conversation of its own, for the suites that need only the row
export async function createMessageOf(
  owner: OwnerClient,
  input: { storeId: string }
): Promise<{ id: string }> {
  const conversation = await createConversationOf(owner, { storeId: input.storeId })
  const message = await createMessage(owner, {
    storeId: input.storeId,
    conversationId: conversation.id
  })
  conversationOfMessage.set(message.id, conversation.id)
  return message
}

// The message each reaction is on: the route to react names the message, not the reaction
export const messageOfReaction = new Map<string, string>()

// An agent's reaction on a message of the customer that the channel knows by id, in a conversation of
// its own. The agent is any member of the store.
export async function createMessageReactionOf(
  owner: OwnerClient,
  input: { storeId: string; userId: string; emoji?: string }
): Promise<{ id: string }> {
  const conversation = await createConversationOf(owner, { storeId: input.storeId })
  const message = await owner.message.create({
    data: {
      storeId: input.storeId,
      conversationId: conversation.id,
      type: MessageType.TEXT,
      content: 'hello',
      authorType: AuthorType.CUSTOMER,
      channelMessageId: `wamid-${randomUUID()}`
    },
    select: { id: true }
  })
  const reaction = await owner.messageReaction.create({
    data: {
      storeId: input.storeId,
      messageId: message.id,
      authorType: AuthorType.AGENT,
      userId: input.userId,
      emoji: input.emoji ?? '👍'
    },
    select: { id: true }
  })
  conversationOfMessage.set(reaction.id, conversation.id)
  messageOfReaction.set(reaction.id, message.id)
  return reaction
}

// The message a revision belongs to, for the checks that reach a revision through its message
export const messageOfRevision = new Map<string, string>()

// A note edited once: it holds the second text, and its revision holds the first
export async function createMessageRevisionOf(
  owner: OwnerClient,
  input: { storeId: string; userId: string }
): Promise<{ id: string }> {
  const conversation = await createConversationOf(owner, { storeId: input.storeId })
  const note = await owner.message.create({
    data: {
      storeId: input.storeId,
      conversationId: conversation.id,
      type: MessageType.INTERNAL_NOTE,
      content: 'note v2',
      authorType: AuthorType.AGENT,
      authorId: input.userId,
      version: 2
    },
    select: { id: true }
  })
  const revision = await owner.messageRevision.create({
    data: {
      storeId: input.storeId,
      messageId: note.id,
      version: 1,
      content: 'note v1',
      editedByType: AuthorType.AGENT,
      editedById: input.userId
    },
    select: { id: true }
  })
  messageOfRevision.set(revision.id, note.id)
  return revision
}

// The conversation each origin hangs from: the route that reads an origin names its conversation
export const conversationOfOrigin = new Map<string, string>()

// An origin (the ad a customer came from) on a message of a conversation of its own
export async function createConversationOriginOf(
  owner: OwnerClient,
  input: { storeId: string }
): Promise<{ id: string }> {
  const conversation = await createConversationOf(owner, { storeId: input.storeId })
  const message = await createMessage(owner, {
    storeId: input.storeId,
    conversationId: conversation.id
  })
  const origin = await owner.conversationOrigin.create({
    data: {
      storeId: input.storeId,
      conversationId: conversation.id,
      messageId: message.id,
      kind: 'ad',
      sourceId: `ad-${randomUUID().slice(0, 8)}`,
      title: 'Summer sale'
    },
    select: { id: true }
  })
  conversationOfOrigin.set(origin.id, conversation.id)
  return origin
}
