import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'

import { ApiRoutes } from '@platform/core/api'
import { PrismaService, RLS_CONTEXT_ENABLED } from '@platform/core/database'
import { connectionUrls, type OwnerClient } from '@platform/core/database-testing'
import { BulkActions, BulkLimits, ChannelIds } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes } from '@platform/core/errors'
import { Events } from '@platform/core/events'
import { ConversationsService } from '@platform/core/messaging'

import { createConversationOf } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { PLAN_SPEC_TABLES, quietTables } from '../helpers/quiet-tables'

const UNREAD = 3
const SEED_CHUNK = 25

interface BulkBody {
  succeeded: string[]
  failed: { id: string; code: string }[]
  truncated: boolean
}

// RLS phase 6: with the switch ON the whole bulk is ONE transaction. A database error in one conversation aborts it (25P02) and
// every later conversation used to fail too, while the answer still told them "one by one". Each change now runs in a savepoint.
describe('RLS phase 6: a bulk action of conversations under enforcement', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let guarded: PrismaService
  let owner: OwnerClient
  let ctx: TestContext

  beforeAll(async () => {
    owner = ownerClient()
    guarded = new PrismaService({
      databaseUrl: connectionUrls().worker,
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
  afterEach(() => {
    jest.restoreAllMocks()
    app.get(EventEmitter2).removeAllListeners(Events.CONVERSATION_READ)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  // Alternating the channel of the rows (a widget one and a connected one), as a real inbox is
  const seed = (count: number) =>
    (async () => {
      const ids: string[] = []
      for (let start = 0; start < count; start += SEED_CHUNK) {
        const size = Math.min(SEED_CHUNK, count - start)
        const rows = await Promise.all(
          Array.from({ length: size }, (_, i) =>
            createConversationOf(owner, {
              storeId: ctx.storeA.id,
              unreadCount: UNREAD,
              channelType: (start + i) % 2 === 0 ? ChannelIds.WEB_WIDGET : ChannelIds.INSTAGRAM
            })
          )
        )
        ids.push(...rows.map(row => row.id))
      }
      return ids
    })()

  const unreadOf = async (id: string) =>
    (await owner.conversation.findUniqueOrThrow({ where: { id } })).unreadCount

  const bulk = (body: object) =>
    api(app, ctx.adminA, ctx.storeA).post(ApiRoutes.conversations.bulk).send(body)

  it('keeps the rest of the batch going when one conversation fails in the database', async () => {
    const [first, second, third] = (await seed(3)) as [string, string, string]
    const missing = randomUUID()
    const conversations = app.get(ConversationsService)
    const original = conversations.markRead.bind(conversations)
    // The write of the second one goes through and then the database refuses: only a database error aborts the transaction
    jest.spyOn(conversations, 'markRead').mockImplementation(async (storeId, id, viewer) => {
      const detail = await original(storeId, id, viewer)
      if (id === second) await guarded.transaction(tx => tx.$executeRawUnsafe('SELECT 1 / 0'))
      return detail
    })
    const read: string[] = []
    const listener = (payload: { conversationId: string }): void => {
      read.push(payload.conversationId)
    }
    const events = app.get(EventEmitter2)
    events.on(Events.CONVERSATION_READ, listener)

    const response = await bulk({
      action: BulkActions.MARK_READ,
      conversationIds: [first, second, missing, third]
    })
    events.off(Events.CONVERSATION_READ, listener)
    jest.restoreAllMocks()

    expect(response.status).toBe(HttpStatusCodes.OK)
    const body = response.body as BulkBody
    expect(body.succeeded).toEqual([first, third])
    expect(body.failed).toEqual([
      { id: second, code: ErrorCodes.INTERNAL_ERROR },
      { id: missing, code: ErrorCodes.RESOURCE_NOT_FOUND }
    ])
    // What went through stays after the commit, what the failed one wrote before it failed is gone
    expect(await unreadOf(first)).toBe(0)
    expect(await unreadOf(third)).toBe(0)
    expect(await unreadOf(second)).toBe(UNREAD)
    // No event of the reverted one, and the events of the others
    expect(read.toSorted()).toEqual([first, third].toSorted())
  })

  // Measures, it does not judge: the activation waits on this number (more than about 8 s means batches of its own)
  it('marks as read a bulk of the full limit in one answer, and says how long it took', async () => {
    await quietTables(owner, PLAN_SPEC_TABLES)
    const ids = await seed(BulkLimits.MAX_ITEMS)
    const startedAt = Date.now()
    const response = await bulk({ action: BulkActions.MARK_READ, conversationIds: ids })
    const elapsedMs = Date.now() - startedAt
    process.stdout.write(
      `bulk MARK_READ under RLS: n=${ids.length} total=${elapsedMs} ms per item=${(elapsedMs / ids.length).toFixed(1)} ms\n`
    )

    expect(response.status).toBe(HttpStatusCodes.OK)
    const body = response.body as BulkBody
    expect(body.failed).toEqual([])
    expect(body.succeeded).toHaveLength(BulkLimits.MAX_ITEMS)
    const stillUnread = await owner.conversation.count({
      where: { id: { in: ids }, unreadCount: { gt: 0 } }
    })
    expect(stillUnread).toBe(0)
  }, 120_000)

  // A savepoint does not save a transaction that is gone: the answer must be an error, never a 200 that names as done what the
  // rollback then undoes
  it('answers with an error, and changes nothing, when the transaction of the whole bulk dies midway', async () => {
    const [first, second, third] = (await seed(3)) as [string, string, string]
    const conversations = app.get(ConversationsService)
    const original = conversations.markRead.bind(conversations)
    jest.spyOn(conversations, 'markRead').mockImplementation(async (storeId, id, viewer) => {
      const detail = await original(storeId, id, viewer)
      if (id === second)
        await guarded.transaction(tx =>
          tx.$executeRawUnsafe('SELECT pg_terminate_backend(pg_backend_pid())')
        )
      return detail
    })

    const response = await bulk({
      action: BulkActions.MARK_READ,
      conversationIds: [first, second, third]
    })
    jest.restoreAllMocks()

    expect(response.status).toBeGreaterThanOrEqual(HttpStatusCodes.INTERNAL_SERVER_ERROR)
    expect(await unreadOf(first)).toBe(UNREAD)
    expect(await unreadOf(second)).toBe(UNREAD)
    expect(await unreadOf(third)).toBe(UNREAD)
  })
})
