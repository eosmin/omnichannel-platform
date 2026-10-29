import type { INestApplication } from '@nestjs/common'

import { PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import { AuthorType, DeliveryStatus, MessageType, ReactionActors } from '@platform/core/domain'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import {
  ChannelConnectionResolver,
  InboundMessageChangesService,
  InboundMessageTargets
} from '@platform/core/messaging'
import { PluginRegistry } from '@platform/plugins/runtime'

import {
  buildChannelPlugin,
  createConversation,
  createCustomerIdentity,
  ensurePluginInstallation,
  TEST_CHANNEL_ID
} from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

describe('Edits and deletions that a channel delivers', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let changes: InboundMessageChangesService
  let handle = 0
  let published: { event: string; payload: Record<string, unknown> }[] = []

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    app.get(PluginRegistry, { strict: false }).register(buildChannelPlugin())
    const prisma = app.get(PrismaService, { strict: false })
    const events = app.get(DomainEvents, { strict: false })
    changes = new InboundMessageChangesService(
      prisma,
      new InboundMessageTargets(prisma, new ChannelConnectionResolver(prisma)),
      events
    )
    jest.spyOn(events, 'publish').mockImplementation((_tx, event, payload) => {
      published.push({
        event: String(event),
        payload: payload as unknown as Record<string, unknown>
      })
    })
  })
  afterAll(async () => {
    jest.restoreAllMocks()
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(() => {
    published = []
  })

  // A customer on a connection of the store, with one message of the given author and provider id
  const thread = async (
    over: { authorType?: AuthorType; storeId?: string } = {}
  ): Promise<{ connectionId: string; channelIdentity: string; messageId: string; mid: string }> => {
    const storeId = over.storeId ?? ctx.storeA.id
    const connectionId = `${prefix}-conn-${(handle += 1)}`
    const channelIdentity = `50372${String(handle).padStart(6, '0')}`
    const mid = `mid-${handle}`
    const installation = await ensurePluginInstallation(owner, {
      storeId,
      pluginId: TEST_CHANNEL_ID
    })
    const connection = await owner.channelConnection.create({
      data: {
        storeId,
        pluginId: TEST_CHANNEL_ID,
        installationId: installation.id,
        connectionId,
        displayName: 'test connection',
        status: 'active',
        credentials: Buffer.from('not a secret')
      }
    })
    const identity = await createCustomerIdentity(owner, {
      storeId,
      channelType: TEST_CHANNEL_ID,
      handle: channelIdentity
    })
    const conversation = await createConversation(owner, {
      storeId,
      customerId: identity.customerId,
      customerIdentityId: identity.id,
      channelType: TEST_CHANNEL_ID,
      channelConnectionId: connection.id
    })
    const message = await owner.message.create({
      data: {
        storeId,
        conversationId: conversation.id,
        type: MessageType.TEXT,
        content: 'original text',
        authorType: over.authorType ?? AuthorType.CUSTOMER,
        channelMessageId: mid
      },
      select: { id: true }
    })
    return { connectionId, channelIdentity, messageId: message.id, mid }
  }
  const edit = (
    t: { connectionId: string; channelIdentity: string; mid: string },
    content: string
  ) => ({
    connectionId: t.connectionId,
    channelIdentity: t.channelIdentity,
    edit: { targetExternalId: t.mid, content }
  })
  const deletion = (
    t: { connectionId: string; channelIdentity: string; mid: string },
    from?: typeof ReactionActors.EXTERNAL
  ) => ({
    connectionId: t.connectionId,
    channelIdentity: t.channelIdentity,
    deletion: { targetExternalId: t.mid, ...(from ? { from } : {}) }
  })
  const stored = (id: string) =>
    owner.message.findUniqueOrThrow({
      where: { id },
      select: {
        content: true,
        version: true,
        editedAt: true,
        editedByType: true,
        deletedAt: true,
        deletedByType: true,
        deletedById: true
      }
    })

  describe('an edit', () => {
    it('replaces the text, keeps the old one as a revision and tells the team', async () => {
      const t = await thread()

      await changes.handleEdited(TEST_CHANNEL_ID, edit(t, 'new text'), true)

      expect(await stored(t.messageId)).toMatchObject({
        content: 'new text',
        version: 2,
        editedByType: AuthorType.CUSTOMER
      })
      const revisions = await owner.messageRevision.findMany({ where: { messageId: t.messageId } })
      expect(revisions).toEqual([
        expect.objectContaining({
          version: 1,
          content: 'original text',
          editedByType: AuthorType.CUSTOMER,
          storeId: ctx.storeA.id
        })
      ])
      expect(published.map(item => item.event)).toEqual([Events.MESSAGE_EDITED])
      expect(published[0]?.payload).toMatchObject({ messageId: t.messageId, internal: false })
    })

    it('keeps every revision of a message edited twice', async () => {
      const t = await thread()

      await changes.handleEdited(TEST_CHANNEL_ID, edit(t, 'second'), true)
      await changes.handleEdited(TEST_CHANNEL_ID, edit(t, 'third'), true)

      expect((await stored(t.messageId)).content).toBe('third')
      const revisions = await owner.messageRevision.findMany({
        where: { messageId: t.messageId },
        orderBy: { version: 'asc' }
      })
      expect(revisions.map(revision => revision.content)).toEqual(['original text', 'second'])
    })

    it('changes nothing for the text it already has, as a redelivered webhook', async () => {
      const t = await thread()
      await changes.handleEdited(TEST_CHANNEL_ID, edit(t, 'new text'), true)
      published = []

      await changes.handleEdited(TEST_CHANNEL_ID, edit(t, 'new text'), true)

      expect((await stored(t.messageId)).version).toBe(2)
      expect(await owner.messageRevision.count({ where: { messageId: t.messageId } })).toBe(1)
      expect(published).toHaveLength(0)
    })

    it('is recorded as the owner’s when it comes from the provider’s own app', async () => {
      const t = await thread({ authorType: AuthorType.EXTERNAL })

      await changes.handleEdited(
        TEST_CHANNEL_ID,
        { ...edit(t, 'fixed'), edit: { ...edit(t, 'fixed').edit, from: ReactionActors.EXTERNAL } },
        true
      )

      expect((await stored(t.messageId)).editedByType).toBe(AuthorType.EXTERNAL)
    })

    it('does not touch a message that was deleted', async () => {
      const t = await thread()
      await changes.handleDeleted(TEST_CHANNEL_ID, deletion(t), true)

      await changes.handleEdited(TEST_CHANNEL_ID, edit(t, 'too late'), true)

      expect((await stored(t.messageId)).content).toBe('original text')
    })

    it('waits for a message that is not stored yet, and drops it on the last attempt', async () => {
      const t = await thread()
      const early = { ...edit(t, 'x'), edit: { targetExternalId: 'not-here', content: 'x' } }

      await expect(changes.handleEdited(TEST_CHANNEL_ID, early, false)).rejects.toThrow(
        'before the message'
      )
      await expect(changes.handleEdited(TEST_CHANNEL_ID, early, true)).resolves.toBeUndefined()
    })

    it('never reaches a message of another store', async () => {
      const mine = await thread()
      const theirs = await thread({ storeId: ctx.storeB.id })

      await changes.handleEdited(
        TEST_CHANNEL_ID,
        { ...edit(mine, 'x'), edit: { targetExternalId: theirs.mid, content: 'hijacked' } },
        true
      )

      expect((await stored(theirs.messageId)).content).toBe('original text')
    })
  })

  describe('with the agents', () => {
    it('numbers a revision after those the message already has, whoever made them', async () => {
      const t = await thread()
      // An edit of ours that was asked for and refused moved the version without a revision
      await owner.message.update({ where: { id: t.messageId }, data: { version: 3 } })
      await owner.messageRevision.create({
        data: {
          storeId: ctx.storeA.id,
          messageId: t.messageId,
          version: 1,
          content: 'older',
          editedByType: AuthorType.AGENT
        }
      })

      await changes.handleEdited(TEST_CHANNEL_ID, edit(t, 'new text'), true)

      const versions = await owner.messageRevision.findMany({
        where: { messageId: t.messageId },
        orderBy: { version: 'asc' },
        select: { version: true }
      })
      expect(versions.map(revision => revision.version)).toEqual([1, 2])
    })

    it('takes the echo of a deletion we asked for as that deletion, by the agent who asked', async () => {
      const t = await thread({ authorType: AuthorType.AGENT })
      await owner.message.update({
        where: { id: t.messageId },
        data: {
          deleteStatus: DeliveryStatus.QUEUED,
          deletedByType: AuthorType.AGENT,
          deletedById: ctx.agentA.id,
          changeRequestedAt: new Date()
        }
      })

      await changes.handleDeleted(TEST_CHANNEL_ID, deletion(t, ReactionActors.EXTERNAL), true)

      expect(await stored(t.messageId)).toMatchObject({
        deletedByType: AuthorType.AGENT,
        deletedById: ctx.agentA.id
      })
      const row = await owner.message.findUniqueOrThrow({
        where: { id: t.messageId },
        select: { deleteStatus: true, deletedAt: true, changeRequestedAt: true }
      })
      expect(row.deleteStatus).toBe(DeliveryStatus.SENT)
      expect(row.deletedAt).not.toBeNull()
      expect(row.changeRequestedAt).toBeNull()
    })
  })

  describe('a customer who deletes many messages at once', () => {
    const COUNT = 100
    const WORKERS = 20

    it('leaves every message a tombstone and tells the team once for each', async () => {
      const t = await thread()
      const first = await owner.message.findUniqueOrThrow({
        where: { id: t.messageId },
        select: { conversationId: true }
      })
      const mids = Array.from({ length: COUNT }, (_, index) => `${t.mid}-bulk-${index}`)
      await owner.message.createMany({
        data: mids.map(mid => ({
          storeId: ctx.storeA.id,
          conversationId: first.conversationId,
          type: MessageType.TEXT,
          content: 'to delete',
          authorType: AuthorType.CUSTOMER,
          channelMessageId: mid
        }))
      })
      published = []

      // As the worker does: jobs of the same customer, WORKERS of them at a time
      const started = Date.now()
      for (let from = 0; from < mids.length; from += WORKERS) {
        await Promise.all(
          mids
            .slice(from, from + WORKERS)
            .map(mid => changes.handleDeleted(TEST_CHANNEL_ID, deletion({ ...t, mid }), true))
        )
      }
      const elapsedMs = Date.now() - started

      const deleted = await owner.message.count({
        where: { conversationId: first.conversationId, deletedAt: { not: null } }
      })
      expect(deleted).toBe(COUNT)
      expect(published.filter(item => item.event === Events.MESSAGE_DELETED)).toHaveLength(COUNT)
      // A bound that only a broken lock or a query per row per row would break: it is measured, not tuned
      process.stdout.write(`bulk deletion of ${COUNT} messages: ${elapsedMs} ms\n`)
      expect(elapsedMs).toBeLessThan(30_000)
    })
  })

  describe('a deletion', () => {
    it('turns the message into a tombstone that the customer deleted, and tells the team', async () => {
      const t = await thread()

      await changes.handleDeleted(TEST_CHANNEL_ID, deletion(t), true)

      const message = await stored(t.messageId)
      expect(message).toMatchObject({
        deletedByType: AuthorType.CUSTOMER,
        deletedById: null,
        content: 'original text'
      })
      expect(message.deletedAt).not.toBeNull()
      expect(published.map(item => item.event)).toEqual([Events.MESSAGE_DELETED])
    })

    it('is recorded as the owner’s when it comes from the provider’s own app', async () => {
      const t = await thread({ authorType: AuthorType.EXTERNAL })

      await changes.handleDeleted(TEST_CHANNEL_ID, deletion(t, ReactionActors.EXTERNAL), true)

      expect((await stored(t.messageId)).deletedByType).toBe(AuthorType.EXTERNAL)
    })

    it('happens once: a redelivered webhook changes nothing and says nothing', async () => {
      const t = await thread()
      await changes.handleDeleted(TEST_CHANNEL_ID, deletion(t), true)
      const first = (await stored(t.messageId)).deletedAt
      published = []

      await changes.handleDeleted(TEST_CHANNEL_ID, deletion(t), true)

      expect((await stored(t.messageId)).deletedAt).toEqual(first)
      expect(published).toHaveLength(0)
    })
  })
})
