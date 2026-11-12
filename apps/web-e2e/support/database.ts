import { randomInt, randomUUID } from 'node:crypto'

import { type Permission, Permissions, RoleNames } from '@platform/core/auth'
import { encryptJson, parseEncryptionKey } from '@platform/core/crypto'
import {
  createOwnerClient,
  ensureMembership,
  ensureStore,
  ensureSystemRoles,
  ensureUser,
  type OwnerClient,
  slugify
} from '@platform/core/database-testing'
import {
  AuthorType,
  type CaptionState,
  ChannelConnectionStatus,
  ChannelIds,
  type DeliveryStatus,
  MediaStatus,
  MessageType,
  OriginKinds,
  OriginMediaSlots,
  PaymentStatus,
  type SystemMessageEvent
} from '@platform/core/domain'
import { ExportTypes } from '@platform/core/queues'
import { MediaPurpose, StorageKeys } from '@platform/core/storage'

// The e2e cases build their rows with the builders of the suites in tests/
// eslint-disable-next-line no-restricted-imports -- the only deep relative import, to a folder no alias covers
import {
  createCarrierConnection,
  createChannelConnection,
  createConversation,
  createConversationOf,
  createCustomer,
  createInventoryLevel,
  createInventoryMovement,
  createProduct,
  createShipment,
  createOrder,
  createPickup,
  createGuideOn,
  createRemittance,
  createWarehouse as createWarehouseRow,
  linkWarehouse,
  createCustomerIdentity,
  createMessage,
  createSnippet,
  type MetadataValue,
  createRole,
  createTag,
  ensurePluginInstallation
} from '../../../tests/builders'

import { credentialsEncryptionKey, databaseUrls } from './env'
import { FAKE_ACCESS_TOKEN, FAKE_BUSINESS_ACCOUNT_ID, FAKE_PHONE_NUMBER_ID } from './fake-graph'

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
    system?: {
      event: SystemMessageEvent
      actorType: 'user' | 'system'
      // The code the system gave (a snooze that ran out) and what the agent wrote when snoozing
      reason?: string
      note?: string
    }
    replyToMessageId?: string
    // The file of an album the reply quotes (with `replyToMessageId`)
    replyToMediaId?: string
    // The code a reply failed with, shown beside it
    deliveryError?: string
    // How the text of a reply went when the channel sent it as a message of its own
    captionState?: CaptionState
    // The text of the message is a message of its own after the files, not the text under the first one
    textApart?: boolean
    // The id the provider gave the message (the first file of an album is the message)
    channelMessageId?: string
    // For a reply that failed: true when it is known not to have gone out, false or null when it may have
    failureDefinitive?: boolean | null
    // The channel's own data: the place of a location, or the mark of a sticker
    metadata?: Record<string, MetadataValue>
    // Files of the customer the worker gave up on, as it records them in the metadata
    unavailableFiles?: { index: number; code: string }[]
  }
): Promise<{ id: string }> {
  return withOwner(async owner => {
    const { id } = await createMessage(owner, { storeId, conversationId, ...input })
    const { deliveryStatus, system, replyToMessageId, unavailableFiles, deliveryError } = input
    if (unavailableFiles !== undefined) {
      await owner.message.update({ where: { id }, data: { metadata: { unavailableFiles } } })
    }
    if (deliveryError !== undefined) {
      await owner.message.update({ where: { id }, data: { deliveryError } })
    }
    if (input.captionState !== undefined) {
      await owner.message.update({ where: { id }, data: { captionState: input.captionState } })
    }
    if (input.replyToMediaId !== undefined) {
      await owner.message.update({
        where: { id },
        data: { replyToMediaId: input.replyToMediaId }
      })
    }
    if (input.channelMessageId !== undefined) {
      await owner.message.update({
        where: { id },
        data: { channelMessageId: input.channelMessageId }
      })
    }
    if (input.textApart !== undefined) {
      await owner.message.update({ where: { id }, data: { textApart: input.textApart } })
    }
    if (input.failureDefinitive !== undefined) {
      await owner.message.update({
        where: { id },
        data: { failureDefinitive: input.failureDefinitive }
      })
    }
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
                  reason: system.reason ?? null,
                  snoozedUntil: null,
                  assignedTo: null,
                  previousAssignee: null,
                  ...(system.note === undefined ? {} : { note: system.note })
                }
              })
        }
      })
    }
    return { id }
  })
}

// The first message of a conversation, the one of the customer that the fixtures write
export function firstMessageIdOf(conversationId: string): Promise<string> {
  return withOwner(async owner => {
    const row = await owner.message.findFirstOrThrow({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      select: { id: true }
    })
    return row.id
  })
}

// The message the reply of the team with this text quotes, or null when it quotes none; undefined while
// that reply does not exist
export function quotedByReplyIn(
  conversationId: string,
  content: string
): Promise<string | null | undefined> {
  return withOwner(
    async owner =>
      (
        await owner.message.findFirst({
          where: { conversationId, authorType: AuthorType.AGENT, content },
          select: { replyToMessageId: true }
        })
      )?.replyToMessageId
  )
}

// Many messages in one go, one a minute apart and the last one a minute ago, for the cases that need
// more than a page of the thread
// The conversation that holds a message with this text, or null while none does. A page may draw what the person
// just sent before the api and the worker have stored it, so a case that looks the conversation up polls this.
export function conversationIdWithMessage(
  storeId: string,
  content: string
): Promise<string | null> {
  return withOwner(async owner => {
    const found = await owner.conversation.findFirst({
      where: { storeId, messages: { some: { content } } },
      orderBy: { createdAt: 'desc' },
      select: { id: true }
    })
    return found?.id ?? null
  })
}

// Many messages in one write, each with its own moment: a long thread for a case that scrolls. One write, not one
// connection for each message, so that the length of the thread does not depend on how fast the database is.
export function addMessagesAt(
  storeId: string,
  conversationId: string,
  messages: readonly { content: string; authorType: AuthorType; createdAt: Date }[]
): Promise<void> {
  return withOwner(async owner => {
    await owner.message.createMany({
      data: messages.map(message => ({
        storeId,
        conversationId,
        type: MessageType.TEXT,
        content: message.content,
        authorType: message.authorType,
        createdAt: message.createdAt
      }))
    })
  })
}

export function addManyMessagesTo(
  storeId: string,
  conversationId: string,
  count: number
): Promise<void> {
  const MINUTE_MS = 60_000
  const now = Date.now()
  return addMessagesAt(
    storeId,
    conversationId,
    Array.from({ length: count }, (_, index) => ({
      content: `Message number ${index + 1}`,
      authorType: index % 2 === 0 ? AuthorType.CUSTOMER : AuthorType.AGENT,
      createdAt: new Date(now - (count - index) * MINUTE_MS)
    }))
  )
}

// The ad a conversation came from. With `picture` the origin also has a thumbnail in the state the scan
// left it, and the address the provider sent for it (which the card must not draw): the row is enough,
// the signed links are made from the key without reading the bucket.
export function addOriginTo(
  storeId: string,
  conversationId: string,
  messageId: string,
  title: string,
  picture?: { status: MediaStatus; remoteUrl: string }
): Promise<void> {
  return withOwner(async owner => {
    const origin = await owner.conversationOrigin.create({
      data: {
        storeId,
        conversationId,
        messageId,
        kind: OriginKinds.AD,
        title,
        ...(picture === undefined ? {} : { thumbnailUrl: picture.remoteUrl })
      }
    })
    if (picture === undefined) return
    const id = randomUUID()
    await owner.media.create({
      data: {
        id,
        storeId,
        originId: origin.id,
        originSlot: OriginMediaSlots.THUMBNAIL,
        purpose: MediaPurpose.ORIGIN,
        key: `stores/${storeId}/messages/${id}/ad-thumb.png`,
        filename: 'ad-thumb.png',
        contentType: 'image/png',
        fileSize: 2048,
        status: picture.status
      }
    })
  })
}

export function messagesOf(
  conversationId: string
): Promise<{ content: string | null; idempotencyKey: string | null }[]> {
  return withOwner(owner =>
    owner.message.findMany({
      // What somebody wrote: the lines of the system (resolved, assigned on a reply...) are not messages
      where: { conversationId, type: { not: MessageType.SYSTEM } },
      select: { content: true, idempotencyKey: true }
    })
  )
}

// The files the agent sent in a conversation, in the order of their place in the message, with the text of
// the message they belong to (the caption goes with the message)
// The text stored under each file of the messages of a conversation, in the order of the message
export function captionsStoredIn(
  conversationId: string
): Promise<{ filename: string; caption: string | null }[]> {
  return withOwner(async owner => {
    const rows = await owner.media.findMany({
      where: { message: { conversationId } },
      orderBy: [{ messageId: 'asc' }, { position: 'asc' }],
      select: { filename: true, caption: true }
    })
    return rows.map(row => ({ filename: row.filename, caption: row.caption }))
  })
}

export function filesSentIn(
  conversationId: string
): Promise<
  { filename: string; position: number | null; caption: string | null; text: string | null }[]
> {
  return withOwner(async owner => {
    const rows = await owner.media.findMany({
      where: { message: { conversationId } },
      orderBy: [{ messageId: 'asc' }, { position: 'asc' }],
      select: {
        filename: true,
        position: true,
        caption: true,
        message: { select: { content: true } }
      }
    })
    // `caption` is the text under the file; `text` the text of the message it belongs to
    return rows.map(row => ({
      filename: row.filename,
      position: row.position,
      caption: row.caption,
      text: row.message?.content ?? null
    }))
  })
}

// How each file of a message stands toward the channel, in the order of the message
export function deliveryOfFiles(
  messageId: string
): Promise<{ filename: string; delivery: string | null; errorCode: string | null }[]> {
  return withOwner(async owner => {
    const rows = await owner.media.findMany({
      where: { messageId },
      orderBy: { position: 'asc' },
      select: { filename: true, deliveryStatus: true, sendErrorCode: true }
    })
    return rows.map(row => ({
      filename: row.filename,
      delivery: row.deliveryStatus,
      errorCode: row.sendErrorCode
    }))
  })
}

export async function storeIdNamed(name: string): Promise<string> {
  const store = await withOwner(owner => owner.store.findFirst({ where: { name } }))
  if (store === null) throw new Error(`no store named ${name}`)
  return store.id
}

// The moment a snoozed conversation comes back (null if it is not snoozed)
export async function snoozedUntilOf(conversationId: string): Promise<Date | null> {
  return withOwner(async owner => {
    const row = await owner.conversation.findUniqueOrThrow({ where: { id: conversationId } })
    return row.snoozedUntil
  })
}

// The zone a store counts its hours in (what the settings of the hours save), returning the one it had
export async function setStoreTimezone(storeId: string, timezone: string): Promise<string> {
  return withOwner(async owner => {
    const before = await owner.store.findUniqueOrThrow({ where: { id: storeId } })
    await owner.store.update({ where: { id: storeId }, data: { timezone } })
    return before.timezone
  })
}

// The zone a person chose in their account (null: none), returning the one they had
export async function setUserTimezone(
  email: string,
  timezone: string | null
): Promise<string | null> {
  return withOwner(async owner => {
    const before = await owner.user.findUniqueOrThrow({ where: { email } })
    await owner.user.update({ where: { email }, data: { timezone } })
    return before.timezone
  })
}

// A saved reply with the greeting every case expects ("Hello!"), under a shortcut of its own
export async function addSnippetTo(storeId: string, shortcut: string): Promise<string> {
  return withOwner(async owner => (await createSnippet(owner, { storeId, shortcut })).id)
}

// A conversation whose last message is old, so that it sits far down the list until something raises it
export function ageConversation(conversationId: string, agoMs: number): Promise<void> {
  return withOwner(async owner => {
    await owner.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: new Date(Date.now() - agoMs) }
    })
  })
}

// The time of a snooze that is over, so that the next sweep of the worker wakes the conversation
export function endSnooze(conversationId: string): Promise<void> {
  return withOwner(async owner => {
    await owner.conversation.update({
      where: { id: conversationId },
      data: { snoozedUntil: new Date(Date.now() - 60_000) }
    })
  })
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

// The WhatsApp connection that the fake Graph answers for. The one of the fixtures holds credentials
// that no real call could use (no phone number id), so the cases that reach the provider own theirs.
async function whatsAppConnectionOf(owner: OwnerClient, storeId: string): Promise<string> {
  const installation = await ensurePluginInstallation(owner, {
    storeId,
    pluginId: ChannelIds.WHATSAPP
  })
  const credentials = encryptJson(
    {
      phoneNumberId: FAKE_PHONE_NUMBER_ID,
      businessAccountId: FAKE_BUSINESS_ACCOUNT_ID,
      accessToken: FAKE_ACCESS_TOKEN
    },
    parseEncryptionKey(credentialsEncryptionKey)
  )
  const row = await owner.channelConnection.upsert({
    where: {
      pluginId_connectionId: { pluginId: ChannelIds.WHATSAPP, connectionId: FAKE_PHONE_NUMBER_ID }
    },
    create: {
      storeId,
      pluginId: ChannelIds.WHATSAPP,
      installationId: installation.id,
      connectionId: FAKE_PHONE_NUMBER_ID,
      displayName: '+503 4444-5555',
      status: ChannelConnectionStatus.ACTIVE,
      credentials
    },
    update: {
      storeId,
      installationId: installation.id,
      status: ChannelConnectionStatus.ACTIVE,
      credentials
    },
    select: { id: true }
  })
  return row.id
}

// A WhatsApp conversation whose customer wrote `agoMs` ago: the messaging window counts from there, so
// the age picks the state of the composer (more than 22 hours is the banner, more than 24 is closed)
export function newWhatsAppConversationWrittenAgo(storeId: string, agoMs: number): Promise<string> {
  const WRITTEN_AT = new Date(Date.now() - agoMs)
  return withOwner(async owner => {
    const identity = await createCustomerIdentity(owner, {
      storeId,
      channelType: ChannelIds.WHATSAPP,
      handle: `5037${randomInt(1_000_000, 10_000_000)}`,
      lastInboundAt: WRITTEN_AT
    })
    const conversation = await createConversation(owner, {
      storeId,
      customerId: identity.customerId,
      customerIdentityId: identity.id,
      channelType: ChannelIds.WHATSAPP,
      channelConnectionId: await whatsAppConnectionOf(owner, storeId),
      lastMessageAt: new Date()
    })
    await createMessage(owner, {
      storeId,
      conversationId: conversation.id,
      content: 'Hello, is my order on its way?',
      createdAt: WRITTEN_AT
    })
    return conversation.id
  })
}

// A conversation on a channel other than WhatsApp, whose customer wrote `agoMs` ago, for the cases that only need
// what the channel declares (the directory of channels answers by plugin)
export function newConversationOnChannel(
  storeId: string,
  channelType: string,
  agoMs: number
): Promise<string> {
  const WRITTEN_AT = new Date(Date.now() - agoMs)
  return withOwner(async owner => {
    const identity = await createCustomerIdentity(owner, {
      storeId,
      channelType,
      handle: `psid-${randomInt(1_000_000, 10_000_000)}`,
      lastInboundAt: WRITTEN_AT
    })
    const conversation = await createConversation(owner, {
      storeId,
      customerId: identity.customerId,
      customerIdentityId: identity.id,
      channelType,
      lastMessageAt: new Date()
    })
    await createMessage(owner, {
      storeId,
      conversationId: conversation.id,
      content: 'Hello, is my order on its way?',
      createdAt: WRITTEN_AT
    })
    return conversation.id
  })
}

// A customer with a name, an e-mail and, with a handle, one identity on a channel, for the cases of the
// customers page. The name is what a case looks the customer up by, so it must be unique.
export function newCustomerIn(
  storeId: string,
  input: { name: string; email?: string; channelType?: string; handle?: string }
): Promise<string> {
  return withOwner(async owner => {
    const customer = await createCustomer(owner, { storeId, name: input.name })
    if (input.email !== undefined) {
      await owner.customer.update({ where: { id: customer.id }, data: { email: input.email } })
    }
    if (input.handle !== undefined) {
      await createCustomerIdentity(owner, {
        storeId,
        customerId: customer.id,
        channelType: input.channelType ?? ChannelIds.WHATSAPP,
        handle: input.handle
      })
    }
    return customer.id
  })
}

// The store has a WhatsApp connection, so the channel is among those a handle can be linked on
export function withWhatsAppChannel(storeId: string): Promise<void> {
  return withOwner(async owner => {
    await whatsAppConnectionOf(owner, storeId)
  })
}

// A Messenger connection of the store with what the provider said about its token (`metadata.tokenInfo`, as the
// worker writes it), or with nothing said. Named, so that its card is found by its heading. Returns its id.
export function addConnectionWithTokenInfo(
  storeId: string,
  input: {
    name: string
    tokenInfo?: { kind: string; isValid: boolean; expiresAt: string | null }
  }
): Promise<string> {
  return withOwner(async owner => {
    const connection = await createChannelConnection(owner, {
      storeId,
      channelType: ChannelIds.MESSENGER
    })
    await owner.channelConnection.update({
      where: { id: connection.id },
      data: {
        displayName: input.name,
        ...(input.tokenInfo === undefined
          ? {}
          : {
              metadata: {
                tokenInfo: {
                  scopes: [],
                  checkedAt: new Date().toISOString(),
                  expiryNotifiedFor: null,
                  ...input.tokenInfo
                }
              }
            })
      }
    })
    return connection.id
  })
}

export function removeConnections(ids: readonly string[]): Promise<void> {
  return withOwner(async owner => {
    await owner.channelConnection.deleteMany({ where: { id: { in: [...ids] } } })
  })
}

export function mergedIntoOf(customerId: string): Promise<string | null | undefined> {
  return withOwner(async owner => {
    const row = await owner.customer.findUnique({
      where: { id: customerId },
      select: { mergedIntoId: true }
    })
    return row === null ? undefined : row.mergedIntoId
  })
}

// A tag of the store, for the cases that put it on a customer
export function newTagIn(storeId: string, name: string): Promise<string> {
  return withOwner(async owner => (await createTag(owner, { storeId, name })).id)
}

// What the drawer saved for a customer, read from the database: the name, the tags, how many notes
// and the addresses with their city
export function savedProfileOf(customerId: string): Promise<{
  name: string | null
  tagNames: string[]
  noteCount: number
  cities: (string | null)[]
}> {
  return withOwner(async owner => {
    const row = await owner.customer.findUniqueOrThrow({
      where: { id: customerId },
      select: {
        name: true,
        tags: { select: { name: true } },
        addresses: { select: { city: true } },
        _count: { select: { notes: true } }
      }
    })
    return {
      name: row.name,
      tagNames: row.tags.map(tag => tag.name),
      noteCount: row._count.notes,
      cities: row.addresses.map(address => address.city)
    }
  })
}

// A file of a message in the state the scan left it. The row is enough for the thread: the signed
// links are made from the key without reading the bucket, so no scan or upload is needed.
export function addMediaTo(
  storeId: string,
  messageId: string,
  input: {
    filename: string
    contentType: string
    status: MediaStatus
    // The worker made the variants of a picture, or refused it (settled, with none)
    processed?: 'with-variants' | 'refused'
    // A file of a reply with several: its place in the message and how it stands toward the channel
    position?: number
    delivery?: DeliveryStatus
    sendErrorCode?: string
    // The text under this file
    caption?: string
    // The id the provider gave it: a file with its own is a target of its own for a reaction or a quote
    channelMessageId?: string
  }
): Promise<{ id: string }> {
  return withOwner(async owner => {
    const id = randomUUID()
    await owner.media.create({
      data: {
        id,
        storeId,
        messageId,
        purpose: MediaPurpose.MESSAGE,
        key: `stores/${storeId}/messages/${id}/${input.filename}`,
        filename: input.filename,
        contentType: input.contentType,
        fileSize: 2048,
        status: input.status,
        ...(input.position === undefined ? {} : { position: input.position }),
        ...(input.delivery === undefined ? {} : { deliveryStatus: input.delivery }),
        ...(input.sendErrorCode === undefined ? {} : { sendErrorCode: input.sendErrorCode }),
        ...(input.caption === undefined ? {} : { caption: input.caption }),
        ...(input.channelMessageId === undefined
          ? {}
          : { channelMessageId: input.channelMessageId }),
        ...settledOf(storeId, id, input.processed)
      }
    })
    return { id }
  })
}

// What the worker writes when it is done with a picture: the keys of the variants (the links are signed
// from the key, the bucket is not read), or only the time when it refused the picture
function settledOf(
  storeId: string,
  mediaId: string,
  processed: 'with-variants' | 'refused' | undefined
): { processedAt?: Date; variants?: Record<string, string> } {
  if (processed === undefined) return {}
  if (processed === 'refused') return { processedAt: new Date() }
  return {
    processedAt: new Date(),
    // As the worker writes them: the three keys, none of them uploaded
    variants: {
      full: StorageKeys.messageVariant(storeId, mediaId, 'full'),
      medium: StorageKeys.messageVariant(storeId, mediaId, 'medium'),
      thumb: StorageKeys.messageVariant(storeId, mediaId, 'thumb')
    }
  }
}

// The worker finishing a picture that was waiting: the rows change, nothing announces it
export function settleMedia(storeId: string, mediaId: string): Promise<void> {
  return withOwner(async owner => {
    await owner.media.update({
      where: { id: mediaId },
      data: settledOf(storeId, mediaId, 'with-variants')
    })
  })
}

// A clean file the customer sent, in a conversation of theirs: the gallery reads it by the customer.
// The customer must have an identity (`handle` in `newCustomerIn`), which the conversation goes through.
export function addCustomerFileTo(
  storeId: string,
  customerId: string,
  input: { filename: string; contentType: string; createdAt: Date }
): Promise<{ id: string }> {
  return withOwner(async owner => {
    const identity = await owner.customerIdentity.findFirstOrThrow({
      where: { storeId, customerId },
      select: { id: true, channelType: true }
    })
    const conversation = await createConversation(owner, {
      storeId,
      customerId,
      customerIdentityId: identity.id,
      channelType: identity.channelType,
      lastMessageAt: input.createdAt
    })
    const message = await createMessage(owner, {
      storeId,
      conversationId: conversation.id,
      createdAt: input.createdAt
    })
    const id = randomUUID()
    await owner.media.create({
      data: {
        id,
        storeId,
        messageId: message.id,
        customerId,
        purpose: MediaPurpose.MESSAGE,
        key: `stores/${storeId}/messages/${id}/${input.filename}`,
        filename: input.filename,
        contentType: input.contentType,
        fileSize: 2048,
        status: MediaStatus.CLEAN,
        createdAt: input.createdAt
      }
    })
    return { id }
  })
}

// The ZIP exports of the store that were asked for a customer's gallery, newest first
export function mediaZipsOf(storeId: string): Promise<{ status: string; filters: unknown }[]> {
  return withOwner(owner =>
    owner.export.findMany({
      where: { storeId, type: ExportTypes.MEDIA_ZIP },
      orderBy: { createdAt: 'desc' },
      select: { status: true, filters: true }
    })
  )
}

// A person who may look at the settings of the store and edit none of them: no seeded role holds
// SETTINGS_VIEW without SETTINGS_EDIT, so the case makes one. Returns what removes it again.
export async function addReadOnlySettingsUser(
  storeId: string,
  email: string
): Promise<() => Promise<void>> {
  const { roleId, userId } = await withOwner(async owner => {
    const store = await owner.store.findUniqueOrThrow({
      where: { id: storeId },
      select: { organizationId: true }
    })
    const role = await createRole(owner, {
      storeId,
      name: `E2E read-only ${randomUUID().slice(0, 8)}`,
      permissions: [
        Permissions.SETTINGS_VIEW,
        Permissions.TEAM_VIEW,
        Permissions.CONVERSATIONS_VIEW,
        Permissions.MESSAGES_VIEW
      ]
    })
    const user = await ensureUser(owner, email, 'Read Only Person')
    await ensureMembership(owner, {
      userId: user.id,
      organizationId: store.organizationId,
      storeId,
      roleId: role.id
    })
    return { roleId: role.id, userId: user.id }
  })
  return () =>
    withOwner(async owner => {
      await owner.membership.deleteMany({ where: { userId } })
      await owner.user.deleteMany({ where: { id: userId } })
      await owner.role.deleteMany({ where: { id: roleId } })
    })
}

// A person who may read the carriers of a store and change nothing: settings:view and shipping:view, with no
// settings:manage_carriers. Returns what removes the person and the role again.
export function addShippingViewer(storeId: string, email: string): Promise<() => Promise<void>> {
  return addUserWithPermissions(storeId, {
    email,
    userName: 'Shipping Viewer',
    roleName: 'E2E shipping viewer',
    permissions: [
      Permissions.SETTINGS_VIEW,
      Permissions.SHIPPING_VIEW,
      Permissions.CONVERSATIONS_VIEW,
      Permissions.MESSAGES_VIEW
    ]
  })
}

// A person with a role of exactly these permissions in a store: no seeded role holds the combinations the cases
// need, so the case makes one. Returns what removes the person and the role again.
async function addUserWithPermissions(
  storeId: string,
  input: { email: string; userName: string; roleName: string; permissions: Permission[] }
): Promise<() => Promise<void>> {
  const { roleId, userId } = await withOwner(async owner => {
    const store = await owner.store.findUniqueOrThrow({
      where: { id: storeId },
      select: { organizationId: true }
    })
    const role = await createRole(owner, {
      storeId,
      name: `${input.roleName} ${randomUUID().slice(0, 8)}`,
      permissions: input.permissions
    })
    const user = await ensureUser(owner, input.email, input.userName)
    await ensureMembership(owner, {
      userId: user.id,
      organizationId: store.organizationId,
      storeId,
      roleId: role.id
    })
    return { roleId: role.id, userId: user.id }
  })
  return () =>
    withOwner(async owner => {
      await owner.membership.deleteMany({ where: { userId } })
      await owner.user.deleteMany({ where: { id: userId } })
      await owner.role.deleteMany({ where: { id: roleId } })
    })
}

// A person who runs the catalog (sees, creates, edits and deletes products) without the permission to see
// costs: no seeded role but Admin holds PRODUCTS_VIEW_COST, and Admin holds everything.
export function addCatalogUserWithoutCost(
  storeId: string,
  email: string
): Promise<() => Promise<void>> {
  return addUserWithPermissions(storeId, {
    email,
    userName: 'Catalog Without Cost',
    roleName: 'E2E catalog no cost',
    permissions: [
      Permissions.PRODUCTS_VIEW,
      Permissions.PRODUCTS_CREATE,
      Permissions.PRODUCTS_EDIT,
      Permissions.PRODUCTS_DELETE,
      Permissions.MEDIA_VIEW
    ]
  })
}

// A second store in the organization of a store, with its Admin (the api lists the stores a person belongs to), for
// the cases that link a warehouse to more than one. Returns its id.
export function addStoreToOrganizationOf(
  storeId: string,
  storeName: string,
  adminEmail: string
): Promise<string> {
  return withOwner(async owner => {
    const { organizationId } = await owner.store.findUniqueOrThrow({
      where: { id: storeId },
      select: { organizationId: true }
    })
    const roles = await ensureSystemRoles(owner)
    const store = await ensureStore(owner, organizationId, storeName)
    const user = await ensureUser(owner, adminEmail, 'Done When Owner')
    await ensureMembership(owner, {
      userId: user.id,
      organizationId,
      storeId: store.id,
      roleId: roles[RoleNames.ADMIN].id
    })
    return store.id
  })
}

// A warehouse of the organization of a store, made straight in the database (the cases that only read it)
export function addWarehouseTo(
  storeId: string,
  input: { name: string; code: string }
): Promise<string> {
  return withOwner(async owner => {
    const { organizationId } = await owner.store.findUniqueOrThrow({
      where: { id: storeId },
      select: { organizationId: true }
    })
    const warehouse = await owner.warehouse.create({
      data: { organizationId, name: input.name, code: input.code }
    })
    return warehouse.id
  })
}

// A person who may see the inventory and nothing that changes it (the warehouses screen opens and shows, no
// button changes anything)
export function addInventoryViewer(storeId: string, email: string): Promise<() => Promise<void>> {
  return addUserWithPermissions(storeId, {
    email,
    userName: 'Inventory Viewer',
    roleName: 'E2E inventory viewer',
    permissions: [Permissions.INVENTORY_VIEW, Permissions.PRODUCTS_VIEW]
  })
}

// The one thing a person does before the first screen: a new account with an organization and a
// store of its own, as the Admin of both (nothing in the product creates the first owner, the
// bootstrap does). Nothing else in the database is theirs, so what a case does there cannot reach
// the stores that the other cases share. Returns the id of the store.
export async function addOwnerOfNewStore(email: string, storeName: string): Promise<string> {
  return withOwner(async owner => {
    const roles = await ensureSystemRoles(owner)
    const organization = await owner.organization.upsert({
      where: { slug: slugify(storeName) },
      create: { name: storeName, slug: slugify(storeName) },
      update: {}
    })
    const store = await ensureStore(owner, organization.id, storeName)
    const user = await ensureUser(owner, email, 'Done When Owner')
    await ensureMembership(owner, {
      userId: user.id,
      organizationId: organization.id,
      storeId: store.id,
      roleId: roles[RoleNames.ADMIN].id
    })
    return store.id
  })
}

// A reaction of the customer to a message, or to one file of an album (`mediaId`)
export function addCustomerReactionTo(
  messageId: string,
  input: { emoji: string; mediaId?: string }
): Promise<void> {
  return withOwner(async owner => {
    const message = await owner.message.findUniqueOrThrow({
      where: { id: messageId },
      select: { storeId: true, conversation: { select: { customerIdentityId: true } } }
    })
    await owner.messageReaction.create({
      data: {
        storeId: message.storeId,
        messageId,
        authorType: AuthorType.CUSTOMER,
        customerIdentityId: message.conversation.customerIdentityId,
        emoji: input.emoji,
        ...(input.mediaId === undefined ? {} : { mediaId: input.mediaId })
      }
    })
  })
}

// What the catalog cases read back from the database: the product by its name, with the files that name it
export async function productNamed(name: string): Promise<{
  id: string
  priceCents: number
  costCents: number | null
  active: boolean
  imageMediaId: string | null
  variants: { name: string; priceCents: number | null; costCents: number | null }[]
  media: { id: string; purpose: string; storeId: string | null }[]
} | null> {
  return withOwner(async owner => {
    const product = await owner.product.findFirst({
      where: { name },
      select: {
        id: true,
        priceCents: true,
        costCents: true,
        active: true,
        imageMediaId: true,
        variants: {
          select: { name: true, priceCents: true, costCents: true },
          orderBy: { createdAt: 'asc' }
        },
        media: { select: { id: true, purpose: true, storeId: true } }
      }
    })
    return product
  })
}

// The scan of a picture is the worker's and takes as long as ClamAV does: the cases that need a clean file say
// so here, so that what they check is the screen and not the scanner
export async function markMediaClean(mediaId: string): Promise<void> {
  await withOwner(async owner => {
    await owner.media.update({ where: { id: mediaId }, data: { status: MediaStatus.CLEAN } })
  })
}

// The inventory switches of a store as the database holds them
export function inventorySettingsOf(storeId: string): Promise<{
  allowNegativeStock: boolean
  allowSplitFulfillment: boolean
  defaultLowStockThreshold: number | null
}> {
  return withOwner(owner =>
    owner.storeSettings.findUniqueOrThrow({
      where: { storeId },
      select: {
        allowNegativeStock: true,
        allowSplitFulfillment: true,
        defaultLowStockThreshold: true
      }
    })
  )
}

// A person who may use the inbox and nothing of the orders: the viewer role holds orders:view, so the case makes a
// role without it. Returns what removes it again.
export async function addUserWithoutOrders(
  storeId: string,
  email: string
): Promise<() => Promise<void>> {
  const { roleId, userId } = await withOwner(async owner => {
    const store = await owner.store.findUniqueOrThrow({
      where: { id: storeId },
      select: { organizationId: true }
    })
    const role = await createRole(owner, {
      storeId,
      name: `E2E no orders ${randomUUID().slice(0, 8)}`,
      permissions: [Permissions.CONVERSATIONS_VIEW, Permissions.MESSAGES_VIEW]
    })
    const user = await ensureUser(owner, email, 'Person Without Orders')
    await ensureMembership(owner, {
      userId: user.id,
      organizationId: store.organizationId,
      storeId,
      roleId: role.id
    })
    return { roleId: role.id, userId: user.id }
  })
  return () =>
    withOwner(async owner => {
      await owner.membership.deleteMany({ where: { userId } })
      await owner.user.deleteMany({ where: { id: userId } })
      await owner.role.deleteMany({ where: { id: roleId } })
    })
}

export interface SeededOrder {
  id: string
  orderNumber: string
}

// The line the thread shows for an order that came from the conversation, written straight in the table as the api
// writes it (the system, no text, a strict metadata). `previous` makes it a change of state.
export async function removeOrderLinesOf(conversationId: string): Promise<void> {
  await withOwner(async owner => {
    await owner.message.deleteMany({ where: { conversationId, type: MessageType.ORDER_SUMMARY } })
  })
}

export async function addOrderLineTo(
  storeId: string,
  conversationId: string,
  order: SeededOrder,
  line: { status: string; previous?: string; totalCents?: number }
): Promise<void> {
  await withOwner(async owner => {
    await owner.message.create({
      data: {
        storeId,
        conversationId,
        type: MessageType.ORDER_SUMMARY,
        authorType: AuthorType.SYSTEM,
        content: null,
        metadata: {
          event: line.previous === undefined ? 'created' : 'status_changed',
          orderId: order.id,
          orderNumber: order.orderNumber,
          status: line.status,
          previousStatus: line.previous ?? null,
          totalCents: line.totalCents ?? 1999,
          currency: 'USD',
          itemCount: 1,
          actor: { type: 'system', id: null }
        }
      }
    })
  })
}

// Orders of a customer made straight in the table (the order screens that make them are Step 4.4 PR B): each takes the
// number, the state, the payment and the day of delivery it is given. Returns the customer, the orders (the newest last)
// and what removes them again.
export async function addOrdersTo(
  storeId: string,
  customerName: string,
  orders: readonly {
    status?: string
    paymentStatus?: string
    totalCents?: number
    scheduledDeliveryDate?: string
    customerNotes?: string
    internalNotes?: string
    packingNotes?: string
  }[]
): Promise<{ customerId: string; orders: SeededOrder[]; remove: () => Promise<void> }> {
  const tag = randomUUID().slice(0, 6).toUpperCase()
  const made = await withOwner(async owner => {
    const customer = await createCustomer(owner, { storeId, name: customerName })
    const creator = await ensureUser(owner, 'multi-store@test.com', 'Multi Store')
    const rows: SeededOrder[] = []
    let index = 0
    for (const order of orders) {
      index += 1
      const totalCents = order.totalCents ?? 1000 * index
      const row = await owner.order.create({
        data: {
          storeId,
          customerId: customer.id,
          orderNumber: `E2E-${tag}-${String(index).padStart(2, '0')}`,
          status: order.status ?? 'CONFIRMED',
          paymentStatus: order.paymentStatus ?? 'PENDING',
          paymentMethod: 'CASH',
          subtotalCents: totalCents,
          totalCents,
          createdBy: creator.id,
          ...(order.customerNotes === undefined ? {} : { customerNotes: order.customerNotes }),
          ...(order.internalNotes === undefined ? {} : { internalNotes: order.internalNotes }),
          ...(order.packingNotes === undefined ? {} : { packingNotes: order.packingNotes }),
          // One second apart, so the list is in the order the case expects
          createdAt: new Date(Date.now() - (orders.length - index) * 1000),
          ...(order.scheduledDeliveryDate === undefined
            ? {}
            : { scheduledDeliveryDate: new Date(`${order.scheduledDeliveryDate}T00:00:00Z`) })
        },
        select: { id: true, orderNumber: true }
      })
      rows.push(row)
    }
    return { customerId: customer.id, rows }
  })
  return {
    customerId: made.customerId,
    orders: made.rows,
    remove: () =>
      withOwner(async owner => {
        await owner.order.deleteMany({ where: { customerId: made.customerId } })
        await owner.customer.deleteMany({ where: { id: made.customerId } })
      })
  }
}

// Orders of a customer that hold a live guide (label created, a guide number, no pickup) of one `local` courier of the store:
// the carrier, guide and shipment columns and the guide filter of the orders page read them. The builder makes the shipment
// with its order (a guide only changes status through ShippingService), and the order is handed to the customer.
export async function addGuidedOrdersTo(
  storeId: string,
  customerId: string,
  count: number
): Promise<{
  orders: (SeededOrder & { guideNumber: string })[]
  connectionName: string
  remove: () => Promise<void>
}> {
  const made = await withOwner(async owner => {
    const connection = await createCarrierConnection(owner, {
      storeId,
      prefix: `E${randomUUID()
        .slice(0, 3)
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '0')}`
    })
    const orders: (SeededOrder & { guideNumber: string })[] = []
    for (let index = 0; index < count; index += 1) {
      const guideNumber = `E2E-${randomUUID().slice(0, 8).toUpperCase()}`
      const shipment = await createShipment(owner, {
        storeId,
        connectionId: connection.id,
        guideNumber
      })
      const order = await owner.order.update({
        where: { id: shipment.orderId },
        data: { customerId },
        select: { id: true, orderNumber: true }
      })
      orders.push({ ...order, guideNumber })
    }
    return { connection, orders }
  })
  return {
    orders: made.orders,
    connectionName: made.connection.displayName,
    remove: () =>
      withOwner(async owner => {
        const ids = made.orders.map(order => order.id)
        await owner.shipmentEvent.deleteMany({ where: { shipment: { orderId: { in: ids } } } })
        await owner.shipment.deleteMany({ where: { orderId: { in: ids } } })
        await owner.order.deleteMany({ where: { id: { in: ids } } })
        await owner.carrierService.deleteMany({ where: { connectionId: made.connection.id } })
        await owner.carrierConnection.deleteMany({ where: { id: made.connection.id } })
      })
  }
}

// A person who only receives transfers (and may see the inventory): the receipt screen opens for them, the draft
// does not
export function addTransferReceiver(storeId: string, email: string): Promise<() => Promise<void>> {
  return addUserWithPermissions(storeId, {
    email,
    userName: 'Transfer Receiver',
    roleName: 'E2E transfer receiver',
    permissions: [Permissions.INVENTORY_VIEW, Permissions.INVENTORY_RECEIVE_TRANSFERS]
  })
}

export interface TransferScenario {
  from: { id: string; code: string; name: string }
  to: { id: string; code: string; name: string }
  productName: string
  sku: string
  // The units the origin holds at the start
  units: number
}

// The stock a transfer case starts from, which no screen can put in the database: two warehouses linked to the
// store, and a product with `units` on hand in the first (a movement explains the level, so the kardex agrees).
// The names carry the run, so that the cases of one run find their own rows.
export function addTransferScenario(
  storeId: string,
  run: string,
  units = 10
): Promise<TransferScenario> {
  return withOwner(async owner => {
    const { organizationId } = await owner.store.findUniqueOrThrow({
      where: { id: storeId },
      select: { organizationId: true }
    })
    const code = run.toUpperCase()
    const fromName = `Origin ${run}`
    const toName = `Destination ${run}`
    const from = await createWarehouseRow(owner, {
      organizationId,
      name: fromName,
      code: `OR-${code}`
    })
    const to = await createWarehouseRow(owner, {
      organizationId,
      name: toName,
      code: `DE-${code}`
    })
    await linkWarehouse(owner, { organizationId, storeId, warehouseId: from.id })
    await linkWarehouse(owner, { organizationId, storeId, warehouseId: to.id })
    const sku = `TR-${code}`
    const product = await createProduct(owner, {
      storeId,
      name: `Transfer shoe ${run}`,
      sku
    })
    await createInventoryLevel(owner, {
      storeId,
      productId: product.id,
      warehouseId: from.id,
      onHand: units
    })
    await createInventoryMovement(owner, {
      storeId,
      productId: product.id,
      warehouseId: from.id,
      quantity: units
    })
    return {
      from: { id: from.id, code: from.code, name: fromName },
      to: { id: to.id, code: to.code, name: toName },
      productName: product.name,
      sku,
      units
    }
  })
}

// What a warehouse holds of a product (the level the api keeps), for the cases that check the stock moved
export function onHandOf(warehouseId: string, productName: string): Promise<number> {
  return withOwner(async owner => {
    const level = await owner.inventoryLevel.findFirst({
      where: { warehouseId, product: { name: productName } },
      select: { onHand: true }
    })
    return level?.onHand ?? 0
  })
}

// What the shipping journey of Step 4.14 starts from, which no screen can put in the database: a warehouse linked to the store
// and a `local` courier with its service and guide sequence. The names carry the run, so the cases find their own rows.
export interface ShippingScenario {
  warehouse: { id: string; name: string }
  connection: { id: string; name: string }
  // Takes out what the cases made on top of it (orders, guides, returns); the warehouse stays, because the stock ledger that a
  // received return writes is append-only and keeps it referenced
  remove: () => Promise<void>
}

const SHIPPING_ADDRESS = {
  line1: 'Calle 1 #23',
  city: 'San Salvador',
  state: 'San Salvador',
  country: 'SV'
}

export async function addShippingScenario(storeId: string, run: string): Promise<ShippingScenario> {
  const made = await withOwner(async owner => {
    const { organizationId } = await owner.store.findUniqueOrThrow({
      where: { id: storeId },
      select: { organizationId: true }
    })
    const warehouseName = `Ship origin ${run}`
    const warehouse = await createWarehouseRow(owner, {
      organizationId,
      name: warehouseName,
      code: `SH-${run.toUpperCase()}`
    })
    // The guide leaves from this warehouse: the api refuses a guide of a store whose origin has no address
    await owner.warehouse.update({
      where: { id: warehouse.id },
      data: { address: { line1: 'Bodega 1', city: 'Soyapango', country: 'SV' } }
    })
    await linkWarehouse(owner, { organizationId, storeId, warehouseId: warehouse.id })
    const connection = await createCarrierConnection(owner, {
      storeId,
      displayName: `Courier ${run}`,
      prefix: `J${run
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '0')
        .slice(0, 3)}`
    })
    return { warehouse: { id: warehouse.id, name: warehouseName }, connection }
  })
  const orderIds: string[] = []
  scenarioOrders.set(made.warehouse.id, orderIds)
  return {
    warehouse: made.warehouse,
    connection: { id: made.connection.id, name: made.connection.displayName },
    remove: async () => {
      await removeOrdersAndGuides(orderIds, made.connection.id)
      scenarioOrders.delete(made.warehouse.id)
    }
  }
}

// The orders each scenario made, so that its `remove` takes them out
const scenarioOrders = new Map<string, string[]>()

export interface ShippableOrder {
  id: string
  orderNumber: string
  customerName: string
  productName: string
}

// An order of the scenario's store with one line allocated at its warehouse, the address and the phone a guide needs, and the
// scenario's courier as its carrier
export async function addShippableOrder(
  storeId: string,
  scenario: ShippingScenario,
  status: 'CONFIRMED' | 'DELIVERED' = 'CONFIRMED'
): Promise<ShippableOrder> {
  const made = await withOwner(async owner => {
    const created = await createOrder(owner, {
      storeId,
      status,
      // A delivered order was paid on delivery: money never collected is not given back
      ...(status === 'DELIVERED' ? { paymentStatus: PaymentStatus.COMPLETED } : {}),
      shippingAddress: SHIPPING_ADDRESS,
      allocatedAt: scenario.warehouse.id,
      carrierConnectionId: scenario.connection.id
    })
    return owner.order.findUniqueOrThrow({
      where: { id: created.id },
      select: {
        id: true,
        orderNumber: true,
        customer: { select: { name: true } },
        items: { select: { productName: true } }
      }
    })
  })
  scenarioOrders.get(scenario.warehouse.id)?.push(made.id)
  return {
    id: made.id,
    orderNumber: made.orderNumber,
    customerName: made.customer?.name ?? '',
    productName: made.items[0]?.productName ?? ''
  }
}

// A product the store sells with `units` on hand at the scenario's warehouse: what an exchange sends out instead
export function addStockedProduct(
  storeId: string,
  scenario: ShippingScenario,
  name: string,
  units = 5
): Promise<void> {
  return withOwner(async owner => {
    const product = await createProduct(owner, { storeId, name })
    await createInventoryLevel(owner, {
      storeId,
      productId: product.id,
      warehouseId: scenario.warehouse.id,
      onHand: units
    })
    await createInventoryMovement(owner, {
      storeId,
      productId: product.id,
      warehouseId: scenario.warehouse.id,
      quantity: units
    })
  })
}

// The state the api left a guide of an order in
export function shipmentStatusesOf(orderId: string): Promise<string[]> {
  return withOwner(async owner => {
    const rows = await owner.shipment.findMany({
      where: { orderId },
      select: { status: true },
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(row => row.status)
  })
}

// Takes out the orders a case made and everything that hangs from them: the replacement orders of its exchanges, its returns, its
// guides, its allocations and its customers. Best effort: a row that the stock ledger still holds stays, and must not fail the
// case that already passed.
async function removeOrdersAndGuides(orderIds: string[], connectionId: string): Promise<void> {
  await withOwner(async owner => {
    const returns = await owner.orderReturn.findMany({
      where: { orderId: { in: orderIds } },
      select: { id: true, replacementOrderId: true }
    })
    const all = [
      ...orderIds,
      ...returns.flatMap(row => (row.replacementOrderId === null ? [] : [row.replacementOrderId]))
    ]
    const customers = await owner.order.findMany({
      where: { id: { in: all } },
      select: { customerId: true }
    })
    const attempt = async (run: () => Promise<unknown>): Promise<void> => {
      try {
        await run()
      } catch {
        // Kept by a row that cannot go (the ledger): the next run uses its own names
      }
    }
    await attempt(() =>
      owner.orderReturnLine.deleteMany({ where: { returnId: { in: returns.map(row => row.id) } } })
    )
    await attempt(() => owner.orderReturn.deleteMany({ where: { orderId: { in: orderIds } } }))
    await attempt(() =>
      owner.shipmentEvent.deleteMany({ where: { shipment: { orderId: { in: all } } } })
    )
    await attempt(() => owner.shipment.deleteMany({ where: { orderId: { in: all } } }))
    await attempt(() =>
      owner.orderItemAllocation.deleteMany({ where: { orderItem: { orderId: { in: all } } } })
    )
    await attempt(() => owner.order.deleteMany({ where: { id: { in: all } } }))
    await attempt(() =>
      owner.customer.deleteMany({
        where: {
          id: { in: customers.flatMap(row => (row.customerId === null ? [] : [row.customerId])) }
        }
      })
    )
    await attempt(() => owner.carrierService.deleteMany({ where: { connectionId } }))
    await attempt(() => owner.carrierConnection.deleteMany({ where: { id: connectionId } }))
  })
}

// A person who sees shipping, the orders and the returns but may not make, cancel or print a guide, nor open a return
export function addShippingReader(storeId: string, email: string): Promise<() => Promise<void>> {
  return addUserWithPermissions(storeId, {
    email,
    userName: 'Shipping Viewer',
    roleName: 'E2E shipping viewer',
    permissions: [Permissions.ORDERS_VIEW, Permissions.SHIPPING_VIEW, Permissions.RETURNS_VIEW]
  })
}

// A person who sees the orders but not shipping: the Shipping panel must not be drawn for them
export function addOrdersViewerWithoutShipping(
  storeId: string,
  email: string
): Promise<() => Promise<void>> {
  return addUserWithPermissions(storeId, {
    email,
    userName: 'Orders Without Shipping',
    roleName: 'E2E orders no shipping',
    permissions: [Permissions.ORDERS_VIEW]
  })
}

// Pickups, a guide waiting for one and a draft remittance of a `local` courier of the store, for the screens that list them
export interface ShippingLists {
  pickupId: string
  waitingGuide: string
  remittanceId: string
  connectionName: string
  remove: () => Promise<void>
}

export async function addShippingLists(storeId: string, run: string): Promise<ShippingLists> {
  const made = await withOwner(async owner => {
    const connection = await createCarrierConnection(owner, {
      storeId,
      displayName: `Lists courier ${run}`,
      prefix: `L${run
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '0')
        .slice(0, 3)}`
    })
    const pickup = await createPickup(owner, { storeId, connectionId: connection.id })
    const guide = await createGuideOn(owner, {
      storeId,
      connectionId: connection.id,
      serviceCode: connection.serviceCode
    })
    const remittance = await createRemittance(owner, {
      storeId,
      connectionId: connection.id,
      withLine: true
    })
    return { connection, pickup, guide, remittance }
  })
  return {
    pickupId: made.pickup.id,
    waitingGuide: made.guide.guideNumber,
    remittanceId: made.remittance.id,
    connectionName: made.connection.displayName,
    remove: () =>
      withOwner(async owner => {
        await owner.codRemittanceLine.deleteMany({ where: { remittanceId: made.remittance.id } })
        await owner.codRemittance.deleteMany({ where: { id: made.remittance.id } })
        await owner.shipmentEvent.deleteMany({ where: { shipmentId: made.guide.id } })
        await owner.shipment.deleteMany({ where: { id: made.guide.id } })
        await owner.order.deleteMany({ where: { id: made.guide.orderId } })
        await owner.pickupRequest.deleteMany({ where: { id: made.pickup.id } })
        await owner.carrierService.deleteMany({ where: { connectionId: made.connection.id } })
        await owner.carrierConnection.deleteMany({ where: { id: made.connection.id } })
      })
  }
}
