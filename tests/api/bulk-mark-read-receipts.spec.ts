import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { ApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import { PrismaService, RLS_CONTEXT_ENABLED } from '@platform/core/database'
import { connectionUrls, type OwnerClient } from '@platform/core/database-testing'
import {
  AuthorType,
  BulkActions,
  ChannelIds,
  MessageType,
  PLUGIN_ACTOR_PREFIX
} from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { OutboundQueue, ReadReceipts, type Viewer } from '@platform/core/messaging'

import { ConversationBulkService } from '../../apps/api/src/modules/conversations/conversation-bulk.service'
import type { Actor as ApiActor } from '../../apps/api/src/modules/tenancy'
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
  let warnings: unknown[][] = []

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
    warnings = []
    // What the services say when a lookup fails: a missing receipt must come with its reason in the failure of the case
    jest.spyOn(PinoLogger.prototype, 'warn').mockImplementation((...args: unknown[]) => {
      if (String(args[1]).includes('read receipts')) warnings.push(args)
    })
    // Each lookup asks the database once (the unit specs of both classes pin that): counting the calls is counting the queries
    for (const [target, method] of [
      [ReadReceipts.prototype, 'latestToMarkMany'],
      [WidgetReadNotifier.prototype, 'targets']
    ] as const) {
      const original = (target as unknown as Record<string, (...a: unknown[]) => unknown>)[method]
      jest
        .spyOn(target as unknown as Record<string, (...a: unknown[]) => unknown>, method)
        .mockImplementation(function (this: unknown, ...args: unknown[]) {
          batchLookups += 1
          return original?.apply(this, args)
        })
    }
    // The prototype: OutboundQueue is provided by several modules, so there are several instances and the one ReadReceipts injects is not
    // the one app.get() returns
    jest.spyOn(OutboundQueue.prototype, 'enqueueReadReceipt').mockImplementation(job => {
      enqueued.push(job)
      return Promise.resolve()
    })
    jest
      .spyOn(WidgetDelivery.prototype, 'readToVisitor')
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

  // The transaction of the request commits once the answer is sent, and the jobs are queued, in one pass, right after that commit.
  // `jobs` is how many jobs the batch must queue: the case waits for them to show up (by that count, never by time), and
  // everything the batch queues or emits is then in. A case that expects a conversation NOT to be told puts a sibling that IS told in
  // the same batch, so that "not there" means "the commit ran and left it out", never "the commit has not run yet".
  const bulk = async (ids: string[], jobs: number) => {
    const response = await api(app, ctx.adminA, ctx.storeA)
      .post(ApiRoutes.conversations.bulk)
      .send({ action: BulkActions.MARK_READ, conversationIds: ids })
    for (let attempt = 0; attempt < 200 && enqueued.length < jobs; attempt += 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 50))
    }
    // A lookup that failed is logged and the reads stand: say it here, or the case only sees a receipt that never came
    expect(JSON.stringify(warnings)).toBe('[]')
    expect(enqueued.length).toBeGreaterThanOrEqual(jobs)
    return response
  }

  const withChannelId = (rows: { channel: string | null }[]) =>
    rows.filter(row => row.channel !== null).length

  // The lookups on their own, in a context of the store, with the three cutoffs that say where the SQL stands: the clock of the
  // database (the one the bulk reads), a far future (the cutoff does not exclude) and the epoch (it excludes everything)
  it('finds the latest message with the cutoff of the clock of the database, and none before the epoch', async () => {
    const [row] = await seed(1)
    const conversationId = row?.id as string
    const [clock] = await owner.$queryRaw<{ now: string }[]>`
      SELECT (clock_timestamp() AT TIME ZONE 'UTC')::text AS now`
    const stored = await owner.$queryRaw<{ created_at: string; zone: string }[]>`
      SELECT created_at::text AS created_at, current_setting('TimeZone') AS zone
      FROM messages WHERE conversation_id = ${conversationId} ORDER BY created_at DESC`
    const found: Record<string, { queued: number; emitted: number }> = {}
    for (const [name, cutoff] of [
      ['clock', clock?.now as string],
      ['future', '2999-01-01 00:00:00'],
      ['epoch', '1970-01-01 00:00:00']
    ] as const) {
      enqueued = []
      emitted = []
      await guarded.inStoreContext(ctx.storeA.id, async () => {
        await app.get(ReadReceipts).queueForMany(ctx.storeA.id, [conversationId], cutoff)
        await app.get(WidgetReadNotifier).notifyMany(ctx.storeA.id, [conversationId], cutoff)
      })
      found[name] = { queued: enqueued.length, emitted: emitted.length }
    }
    const expected = {
      clock: { queued: 1, emitted: 1 },
      future: { queued: 1, emitted: 1 },
      epoch: { queued: 0, emitted: 0 }
    }
    if (JSON.stringify(found) !== JSON.stringify(expected)) {
      // The case says where the SQL stands: what each cutoff found, the clock, what is stored and what the services warned
      throw new Error(`lookups: ${JSON.stringify({ found, clock: clock?.now, stored, warnings })}`)
    }
  })

  it('tells what the lookups of one conversation would, and costs the same queries for 10 as for 40', async () => {
    const small = await seed(1)
    const response = await bulk(
      small.map(row => row.id),
      withChannelId(small)
    )
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
    expect(enqueued).toHaveLength(withChannelId(small))
    expect(emitted.map(row => row.messageId).toSorted()).toEqual(
      small.flatMap(row => (row.widget === null ? [] : [row.widget])).toSorted()
    )

    enqueued = []
    emitted = []
    batchLookups = 0
    const large = await seed(4)
    await bulk(
      large.map(row => row.id),
      withChannelId(large)
    )
    expect(lookupsOfSmall).toBe(2)
    expect(batchLookups).toBe(lookupsOfSmall)
    expect(enqueued).toHaveLength(withChannelId(large))
  }, 120_000)

  it('never asks one conversation at a time', async () => {
    const queueFor = jest.spyOn(ReadReceipts.prototype, 'queueFor')
    const notify = jest.spyOn(WidgetReadNotifier.prototype, 'notify')
    const rows = await seed(1)
    await bulk(
      rows.map(row => row.id),
      withChannelId(rows)
    )
    expect(queueFor).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  }, 60_000)

  it('does not point a receipt at a message that arrived after the batch began', async () => {
    const rows = await seed(1)
    const target = rows[0] as { id: string; channel: string | null }
    // Newer than every clock of the batch: nobody read it. The other conversations of the batch are the control that the jobs ran
    await message(ctx.storeA.id, target.id, {
      createdAt: new Date(Date.now() + 3_600_000),
      channelMessageId: `wamid-${randomUUID()}`
    })
    await bulk(
      rows.map(row => row.id),
      withChannelId(rows)
    )
    expect(enqueued.filter(job => job.conversationId === target.id)).toEqual([
      { storeId: ctx.storeA.id, conversationId: target.id, messageId: target.channel }
    ])
  })

  it('tells nothing for a conversation that failed, nor for one of another store', async () => {
    const foreign = await createConversationOf(owner, { storeId: ctx.storeB.id, unreadCount: 1 })
    await message(ctx.storeB.id, foreign.id, {
      createdAt: new Date(Date.now() - 1_000),
      channelMessageId: `wamid-${randomUUID()}`
    })
    const mine = await seed(1)
    const response = await bulk([...mine.map(row => row.id), foreign.id], withChannelId(mine))
    const body = response.body as BulkBody
    expect(body.failed.map(row => row.id)).toEqual([foreign.id])
    expect(enqueued.map(job => job.conversationId)).not.toContain(foreign.id)
    expect(enqueued).toHaveLength(withChannelId(mine))

    // Even when the id of another store is forced into the batch, the store of the context keeps it out. Both calls queue their
    // hooks when their own transaction commits, before they return, and a sibling of the store is the control that they ran
    enqueued = []
    emitted = []
    const sibling = mine.find(row => row.channel !== null && row.widget !== null) as {
      id: string
      channel: string
      widget: string
    }
    await guarded.inStoreContext(ctx.storeA.id, async () => {
      await app
        .get(ReadReceipts)
        .queueForMany(ctx.storeA.id, [foreign.id, sibling.id], '2999-01-01 00:00:00')
      await app
        .get(WidgetReadNotifier)
        .notifyMany(ctx.storeA.id, [foreign.id, sibling.id], '2999-01-01 00:00:00')
    })
    expect(enqueued).toEqual([
      { storeId: ctx.storeA.id, conversationId: sibling.id, messageId: sibling.channel }
    ])
    expect(emitted.map(row => row.messageId)).toEqual([sibling.widget])
  })

  // A lookup that fails in the database is a savepoint that is rolled back, not a transaction that dies: the reads of the batch stand
  // (they are committed), no receipt is queued and the failure is logged with the size of the batch
  it('keeps the reads of the batch when the lookup of the receipts fails in the database', async () => {
    const rows = await seed(1)
    const ids = rows.map(row => row.id)
    // A real database error (22012), raised inside the same transaction as the reads, where the lookup would have run; only the first
    // call fails, so the sibling batch below goes through the real lookups
    const lookup = jest.spyOn(
      ReadReceipts.prototype as unknown as Record<string, (...a: unknown[]) => unknown>,
      'latestToMarkMany'
    )
    lookup.mockImplementationOnce(() => guarded.client.$queryRaw`SELECT 1 / 0`)
    const response = await api(app, ctx.adminA, ctx.storeA)
      .post(ApiRoutes.conversations.bulk)
      .send({ action: BulkActions.MARK_READ, conversationIds: ids })
    expect(response.status).toBe(HttpStatusCodes.OK)
    expect((response.body as BulkBody).failed).toEqual([])
    expect((response.body as BulkBody).succeeded.toSorted()).toEqual([...ids].toSorted())
    expect(
      await owner.conversation.count({ where: { id: { in: ids }, unreadCount: { gt: 0 } } })
    ).toBe(0)
    expect(JSON.stringify(warnings)).toContain('could not be queued')
    // A sibling batch that IS told, so that "no receipt for the first" means "the commit ran and left it out"
    warnings = []
    const siblings = await seed(1)
    await bulk(
      siblings.map(row => row.id),
      withChannelId(siblings)
    )
    const told = new Set(enqueued.map(job => job.conversationId))
    expect(ids.some(id => told.has(id))).toBe(false)
    expect(told.size).toBe(withChannelId(siblings))
  }, 60_000)

  // A plugin reads without telling the customer that a person saw it: the same batch run as a plugin queues and emits nothing, and
  // a sibling batch run as a person right after tells its customers (so that "nothing" means "the commit ran and left it out")
  it('tells no customer when the reader is a plugin, and tells them when it is a person', async () => {
    const pluginRows = await seed(1)
    const personRows = await seed(1)
    const service = app.get(ConversationBulkService)
    const viewer = {
      userId: `${PLUGIN_ACTOR_PREFIX}fixture-installation`,
      held: Object.values(Permissions),
      canViewAll: true
    } as unknown as Viewer
    const actor = { userId: ctx.adminA.id } as unknown as ApiActor
    const result = await guarded.tenantTransaction(
      {
        storeIds: [ctx.storeA.id],
        organizationIds: [ctx.orgA.id],
        userId: ctx.adminA.id
      },
      () =>
        service.run(
          ctx.storeA.id,
          { action: BulkActions.MARK_READ, conversationIds: pluginRows.map(row => row.id) },
          viewer,
          actor
        )
    )
    expect(result.failed).toEqual([])
    expect(result.succeeded).toHaveLength(pluginRows.length)
    // The plugin read counts as a read, only nobody is told
    expect(
      await owner.conversation.count({
        where: { id: { in: pluginRows.map(row => row.id) }, unreadCount: { gt: 0 } }
      })
    ).toBe(0)
    expect(enqueued).toEqual([])
    expect(emitted).toEqual([])
    const person = await bulk(
      personRows.map(row => row.id),
      withChannelId(personRows)
    )
    expect(person.status).toBe(HttpStatusCodes.OK)
    const told = new Set(enqueued.map(job => job.conversationId))
    expect(pluginRows.some(row => told.has(row.id))).toBe(false)
    expect(told.size).toBe(withChannelId(personRows))
  }, 120_000)

  it('tells nothing when the store switched read receipts off', async () => {
    await owner.storeSettings.updateMany({
      where: { storeId: ctx.storeA.id },
      data: { preferences: { sendReadReceipts: false } }
    })
    const off = await seed(1)
    const offResponse = await bulk(
      off.map(row => row.id),
      0
    )
    expect(offResponse.status).toBe(HttpStatusCodes.OK)
    // The same store with the switch on, in the next batch: its jobs are the control that the first batch had its commit
    await owner.storeSettings.updateMany({
      where: { storeId: ctx.storeA.id },
      data: { preferences: {} }
    })
    const on = await seed(1)
    await bulk(
      on.map(row => row.id),
      withChannelId(on)
    )
    const offIds = new Set(off.map(row => row.id))
    expect(enqueued.filter(job => offIds.has(job.conversationId))).toEqual([])
    expect(enqueued).toHaveLength(withChannelId(on))
  })
})
