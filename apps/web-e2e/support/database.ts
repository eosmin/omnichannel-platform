import { createOwnerClient, type OwnerClient } from '@platform/core/database-testing'
import {
  type AuthorType,
  type DeliveryStatus,
  type MessageType,
  OriginKinds,
  type SystemMessageEvent
} from '@platform/core/domain'

// The e2e cases build their rows with the builders of the suites in tests/
// eslint-disable-next-line no-restricted-imports -- the only deep relative import, to a folder no alias covers
import {
  createConversationOf,
  createMessage,
  createSnippet,
  createTag
} from '../../../tests/builders'

import { databaseUrls } from './env'

// What a case needs in the database that no screen creates yet (the inbox is Step 3.2): reads and
// writes as the owner role, which is the one that sees every store
export async function withOwner<T>(run: (owner: OwnerClient) => Promise<T>): Promise<T> {
  const owner = createOwnerClient(databaseUrls.owner)
  try {
    return await run(owner)
  } finally {
    await owner.$disconnect()
  }
}

// With a date of last message, so that it is among the newest: the list is ordered by it, and one
// with none comes after the pages that a case reads
export function newConversationIn(storeId: string): Promise<string> {
  return withOwner(
    async owner => (await createConversationOf(owner, { storeId, lastMessageAt: new Date() })).id
  )
}

// A tag of the store and a new conversation that carries it, for the filter of the list
export function newTaggedConversationIn(
  storeId: string,
  tagName: string
): Promise<{ conversationId: string; tagId: string }> {
  return withOwner(async owner => {
    const tag = await createTag(owner, { storeId, name: tagName })
    const conversation = await createConversationOf(owner, { storeId, lastMessageAt: new Date() })
    await owner.conversation.update({
      where: { id: conversation.id },
      data: { tags: { connect: { id: tag.id } } }
    })
    return { conversationId: conversation.id, tagId: tag.id }
  })
}

// A conversation that has something to read, for the cases of the thread
export function newConversationWithUnread(storeId: string, unreadCount: number): Promise<string> {
  return withOwner(
    async owner =>
      (await createConversationOf(owner, { storeId, lastMessageAt: new Date(), unreadCount })).id
  )
}

export function unreadCountOf(conversationId: string): Promise<number | undefined> {
  return withOwner(
    async owner =>
      (
        await owner.conversation.findUnique({
          where: { id: conversationId },
          select: { unreadCount: true }
        })
      )?.unreadCount
  )
}

// A message of the customer, a reply with its delivery state, a note or a line of the system, with the
// time given so that the thread keeps its order
export function addMessageTo(
  storeId: string,
  conversationId: string,
  input: {
    content?: string
    authorType?: AuthorType
    type?: MessageType
    createdAt: Date
    deliveryStatus?: DeliveryStatus
    system?: { event: SystemMessageEvent; actorType: 'user' | 'system' }
    replyToMessageId?: string
  }
): Promise<{ id: string }> {
  return withOwner(async owner => {
    const { id } = await createMessage(owner, { storeId, conversationId, ...input })
    const { deliveryStatus, system, replyToMessageId } = input
    if (deliveryStatus !== undefined || system !== undefined || replyToMessageId !== undefined) {
      await owner.message.update({
        where: { id },
        data: {
          ...(deliveryStatus === undefined ? {} : { deliveryStatus }),
          ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
          ...(system === undefined
            ? {}
            : {
                metadata: {
                  event: system.event,
                  actor: { type: system.actorType, id: null },
                  causedBy: null,
                  from: null,
                  to: null,
                  reason: null,
                  snoozedUntil: null,
                  assignedTo: null,
                  previousAssignee: null
                }
              })
        }
      })
    }
    return { id }
  })
}

// Many messages in one go, one a minute apart and the last one a minute ago, for the cases that need
// more than a page of the thread
export function addManyMessagesTo(
  storeId: string,
  conversationId: string,
  count: number
): Promise<void> {
  const MINUTE_MS = 60_000
  return withOwner(async owner => {
    await owner.message.createMany({
      data: Array.from({ length: count }, (_, index) => ({
        storeId,
        conversationId,
        type: 'TEXT',
        content: `Message number ${index + 1}`,
        authorType: index % 2 === 0 ? 'customer' : 'agent',
        createdAt: new Date(Date.now() - (count - index) * MINUTE_MS)
      }))
    })
  })
}

export function addOriginTo(
  storeId: string,
  conversationId: string,
  messageId: string,
  title: string
): Promise<void> {
  return withOwner(async owner => {
    await owner.conversationOrigin.create({
      data: { storeId, conversationId, messageId, kind: OriginKinds.AD, title }
    })
  })
}

export function messagesOf(
  conversationId: string
): Promise<{ content: string | null; idempotencyKey: string | null }[]> {
  return withOwner(owner =>
    owner.message.findMany({
      where: { conversationId },
      select: { content: true, idempotencyKey: true }
    })
  )
}

export async function storeIdNamed(name: string): Promise<string> {
  const store = await withOwner(owner => owner.store.findFirst({ where: { name } }))
  if (store === null) throw new Error(`no store named ${name}`)
  return store.id
}

// A saved reply with the greeting every case expects ("Hello!"), under a shortcut of its own
export async function addSnippetTo(storeId: string, shortcut: string): Promise<string> {
  return withOwner(async owner => (await createSnippet(owner, { storeId, shortcut })).id)
}

export function statusOf(conversationId: string): Promise<string | undefined> {
  return withOwner(
    async owner =>
      (
        await owner.conversation.findUnique({
          where: { id: conversationId },
          select: { status: true }
        })
      )?.status
  )
}

// How resolving behaves in the store: with the options dialog or at once, and the closing message
export async function setResolveBehavior(
  storeId: string,
  behavior: { showOptions: boolean; closingSnippetId: string | null }
): Promise<void> {
  await withOwner(owner =>
    owner.storeSettings.update({
      where: { storeId },
      data: {
        resolveShowOptions: behavior.showOptions,
        sendClosingMessage: behavior.closingSnippetId !== null,
        closingSnippetId: behavior.closingSnippetId
      }
    })
  )
}

// The messages of a conversation in the order they were written: text and type
export function timelineOf(
  conversationId: string
): Promise<{ content: string | null; type: string }[]> {
  return withOwner(owner =>
    owner.message.findMany({
      where: { conversationId },
      select: { content: true, type: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
    })
  )
}

export function mentionsOf(conversationId: string): Promise<string[][]> {
  return withOwner(async owner =>
    (await owner.message.findMany({ where: { conversationId }, select: { mentions: true } })).map(
      row => row.mentions
    )
  )
}
