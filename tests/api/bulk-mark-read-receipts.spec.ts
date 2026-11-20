import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { PrismaService, RLS_CONTEXT_ENABLED } from '@platform/core/database'
import { connectionUrls, type OwnerClient } from '@platform/core/database-testing'
import { AuthorType, BulkActions, ChannelIds, MessageType } from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { OutboundQueue, ReadReceipts } from '@platform/core/messaging'

import { WidgetDelivery } from '../../apps/api/src/modules/widget/widget-delivery.service'
import { WidgetReadNotifier } from '../../apps/api/src/modules/widget/widget-read-notifier.service'
import { createConversationOf } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

interface BulkBody {
  succeeded: string[]
  failed: { id: string; code: string }[]
}

type Variant = 'plain' | 'deleted' | 'no-channel-id' | 'no-content' | 'none'

const VARIANTS: readonly Variant[] = ['plain', 'deleted', 'no-channel-id', 'no-content', 'none']
const CHANNELS = [ChannelIds.WEB_WIDGET, ChannelIds.INSTAGRAM] as const

// MARK_READ of a batch looks up what to tell the customers with two queries for the whole batch, not two per conversation, and
// tells exactly what the lookups of one conversation would have told.
describe('Bulk MARK_READ: receipts and widget notices by batch', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let guarded: PrismaService
  let owner: OwnerClient
  let ctx: TestContext
  let enqueued: { storeId: string; conversationId: string; messageId: string }[] = []
  let emitted: { connectionId: string; channelIdentity: string; messageId: string }[] = []
  let batchLookups = 0

  beforeAll(async () => {
    owner = ownerClient()
    guarded = new PrismaService({
      databaseUrl: connectionUrls().app,
      poolSize: 8,
      requireContext: true
    })
    app = await createTestApp([], builder =>
      builder
        .overrideProvider(PrismaService)
        .useValue(guarded)
        .overrideProvider(RLS_CONTEXT_ENABLED)
        .useValue(true)
    )
    ctx = await seedTestContext(owner, app, prefix)
  })
  beforeEach(async () => {
    enqueued = []
    emitted = []
    batchLookups = 0
    // Each lookup asks the database once (the unit specs of both classes pin that): counting the calls is counting the queries
    for (const [target, method] of [
      [app.get(ReadReceipts), 'latestToMarkMany'],
      [app.get(WidgetReadNotifier), 'targets']
    ] as const) {
      const original = (target as unknown as Record<string, (...a: unknown[]) => unknown>)[method]
      jest
        .spyOn(target as unknown as Record<string, (...a: unknown[]) => unknown>, method)
        .mockImplementation(function (this: unknown, ...args: unknown[]) {
          batchLookups += 1
          return original?.apply(this, args)
        })
    }
    jest.spyOn(app.get(OutboundQueue), 'enqueueReadReceipt').mockImplementation(job => {
      enqueued.push(job)
      return Promise.resolve()
    })
    jest
      .spyOn(app.get(WidgetDelivery), 'readToVisitor')
      .mockImplementation((connectionId, channelIdentity, messageId) => {
        emitted.push({ connectionId, channelIdentity, messageId })
      })
    await owner.storeSettings.updateMany({
      where: { storeId: ctx.storeA.id },
      data: { preferences: {} }
    })
  })
  afterEach(() => {
    jest.restoreAllMocks()
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const message = (
    storeId: string,
    conversationId: string,
    over: { createdAt: Date; channelMessageId?: string; content?: string | null; deletedAt?: Date }
  ) =>
    owner.message
      .create({
        data: {
          storeId,
          conversationId,
          type: MessageType.TEXT,
          authorType: AuthorType.CUSTOMER,
          createdAt: over.createdAt,
          content: over.content === undefined ? 'hello' : over.content,
          ...(over.channelMessageId === undefined
            ? {}
            : { channelMessageId: over.channelMessageId }),
          ...(over.deletedAt === undefined ? {} : { deletedAt: over.deletedAt })
        },
        select: { id: true }
      })
      .then(row => row.id)

  // One conversation per case, on a widget and on another channel; the latest message of the customer is the one the case says,
  // under an older one that is fine, so that a wrong tie-break or a filter that is missing shows up as another id
  const seed = async (rounds: number) => {
    const expected: { id: string; widget: string | null; channel: string | null }[] = []
    for (let round = 0; round < rounds; round += 1) {
      for (const channelType of CHANNELS) {
        for (const variant of VARIANTS) {
          const conversation = await createConversationOf(owner, {
            storeId: ctx.storeA.id,
            unreadCount: 2,
            channelType
          })
          const old = new Date(Date.now() - 60_000)
          const recent = new Date(Date.now() - 30_000)
          const good = await message(ctx.storeA.id, conversation.id, {
            createdAt: old,
            channelMessageId: `wamid-${randomUUID()}`
          })
          let latest: string | null = null
          let noContent: string | null = null
          if (variant === 'plain')
            latest = await message(ctx.storeA.id, conversation.id, {
              createdAt: recent,
              channelMessageId: `wamid-${randomUUID()}`
            })
          if (variant === 'deleted')
            await message(ctx.storeA.id, conversation.id, {
              createdAt: recent,
              channelMessageId: `wamid-${randomUUID()}`,
              deletedAt: new Date()
            })
          if (variant === 'no-channel-id')
            latest = await message(ctx.storeA.id, conversation.id, { createdAt: recent })
          if (variant === 'no-content')
            noContent = await message(ctx.storeA.id, conversation.id, {
              createdAt: recent,
              channelMessageId: `wamid-${randomUUID()}`,
              content: null
            })
          // What each lookup of one conversation answers for this case
          // (the lookup for the channel asks for no text; the one for the widget asks for no id at the channel)
          const channelAnswer =
            variant === 'plain' ? latest : variant === 'no-content' ? noContent : good
          const widgetAnswer =
            channelType !== ChannelIds.WEB_WIDGET
              ? null
              : variant === 'plain' || variant === 'no-channel-id'
                ? latest
                : good
          expected.push({
            id: conversation.id,
            channel: channelAnswer,
            widget: widgetAnswer
          })
        }
      }
    }
    return expected
  }

  const bulk = (ids: string[]) =>
    api(app, ctx.adminA, ctx.storeA)
      .post(ApiRoutes.conversations.bulk)
      .send({ action: BulkActions.MARK_READ, conversationIds: ids })

  it('tells what the lookups of one conversation would, and costs the same queries for 10 as for 40', async () => {
    const small = await seed(1)
    const response = await bulk(small.map(row => row.id))
    expect(response.status).toBe(HttpStatusCodes.OK)
    expect((response.body as BulkBody).failed).toEqual([])
    const lookupsOfSmall = batchLookups
    // The latest message with an id at the channel; the widget ones need text, a live connection and the customer
    expect(enqueued).toEqual(
      expect.arrayContaining(
        small.flatMap(row =>
          row.channel === null
            ? []
            : [{ storeId: ctx.storeA.id, conversationId: row.id, messageId: row.channel }]
        )
      )
    )
    expect(enqueued).toHaveLength(small.filter(row => row.channel !== null).length)
    expect(emitted.map(row => row.messageId).toSorted()).toEqual(
      small.flatMap(row => (row.widget === null ? [] : [row.widget])).toSorted()
    )

    enqueued = []
    emitted = []
    batchLookups = 0
    const large = await seed(4)
    await bulk(large.map(row => row.id))
    expect(lookupsOfSmall).toBe(2)
    expect(batchLookups).toBe(lookupsOfSmall)
    expect(enqueued).toHaveLength(large.filter(row => row.channel !== null).length)
  }, 120_000)

  it('never asks one conversation at a time', async () => {
    const queueFor = jest.spyOn(app.get(ReadReceipts), 'queueFor')
    const notify = jest.spyOn(app.get(WidgetReadNotifier), 'notify')
    const rows = await seed(1)
    await bulk(rows.map(row => row.id))
    expect(queueFor).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  }, 60_000)

  it('does not point a receipt at a message that arrived after the batch began', async () => {
    const [row] = await seed(1)
    const conversationId = row?.id as string
    const early = row?.channel as string
    // Newer than every clock of the batch: nobody read it
    await message(ctx.storeA.id, conversationId, {
      createdAt: new Date(Date.now() + 3_600_000),
      channelMessageId: `wamid-${randomUUID()}`
    })
    await bulk([conversationId])
    expect(enqueued).toEqual([{ storeId: ctx.storeA.id, conversationId, messageId: early }])
  })

  it('tells nothing for a conversation that failed, nor for one of another store', async () => {
    const foreign = await createConversationOf(owner, { storeId: ctx.storeB.id, unreadCount: 1 })
    await message(ctx.storeB.id, foreign.id, {
      createdAt: new Date(Date.now() - 1_000),
      channelMessageId: `wamid-${randomUUID()}`
    })
    const mine = (await seed(1))[0] as { id: string }
    const response = await bulk([mine.id, foreign.id])
    const body = response.body as BulkBody
    expect(body.failed.map(row => row.id)).toEqual([foreign.id])
    expect(enqueued.map(job => job.conversationId)).toEqual([mine.id])

    // Even when the id of another store is forced into the batch, the store of the context keeps it out
    enqueued = []
    await guarded.inStoreContext(ctx.storeA.id, async () => {
      await app.get(ReadReceipts).queueForMany(ctx.storeA.id, [foreign.id], '2999-01-01 00:00:00')
      await app
        .get(WidgetReadNotifier)
        .notifyMany(ctx.storeA.id, [foreign.id], '2999-01-01 00:00:00')
    })
    expect(enqueued).toEqual([])
    expect(emitted).toEqual([])
  })

  it('tells nothing when the store switched read receipts off', async () => {
    await owner.storeSettings.updateMany({
      where: { storeId: ctx.storeA.id },
      data: { preferences: { sendReadReceipts: false } }
    })
    const rows = await seed(1)
    await bulk(rows.map(row => row.id))
    expect(enqueued).toEqual([])
    expect(emitted).toEqual([])
  })
})
