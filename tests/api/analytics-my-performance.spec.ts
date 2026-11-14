import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { RoleNames } from '@platform/core/auth'
import { ensureMembership, ensureStore, type OwnerClient } from '@platform/core/database-testing'
import { AuthorType, ConversationStatus, MessageType } from '@platform/core/domain'

import { createConversationOf, createMessage } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

// GET /analytics/my-performance (Step 5.2 PR B): the figures of the person who asks, for the widget of the inbox. An agent has
// no analytics:view, so the route is open with the permission to see conversations and reads only the person's own.
const MINUTE = 60_000
const HOUR = 60 * MINUTE

interface Body {
  dayStart: string
  resolved: number
  open: number
  medianFirstResponseSeconds: number | null
  answered: number
}

describe('GET /analytics/my-performance', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  // A zone where it is between noon and 13:00 at `now`: "today" of the case started 12 hours and some minutes ago
  // whatever the hour the suite runs, so the times of the case (minutes ago) never cross a midnight. It is not UTC (but
  // at 12:xx UTC), so the day of the store's own zone is what is checked.
  function zoneAtNoon(now: Date): string {
    const offset = ((12 - now.getUTCHours() + 36) % 24) - 12
    if (offset === 0) return 'UTC'
    return offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`
  }

  // A store of its own where agent A and admin A work, in the zone above
  async function aStore(now: Date) {
    const store = await ensureStore(owner, ctx.orgA.id, `${prefix}-${randomUUID().slice(0, 8)}`)
    await owner.store.update({
      where: { id: store.id },
      data: { timezone: zoneAtNoon(now) }
    })
    for (const [actor, role] of [
      [ctx.agentA, RoleNames.AGENT],
      [ctx.adminA, RoleNames.ADMIN]
    ] as const) {
      await ensureMembership(owner, {
        userId: actor.id,
        organizationId: ctx.orgA.id,
        storeId: store.id,
        roleId: ctx.roleIds[role]
      })
    }
    return store
  }

  async function conversation(
    storeId: string,
    dates: {
      createdAt: Date
      firstResponseAt?: Date
      resolvedAt?: Date
      assignedTo?: string
      status?: ConversationStatus
    }
  ) {
    const row = await createConversationOf(owner, {
      storeId,
      ...(dates.status === undefined ? {} : { status: dates.status }),
      ...(dates.assignedTo === undefined ? {} : { assignedTo: dates.assignedTo })
    })
    await owner.conversation.update({
      where: { id: row.id },
      data: {
        createdAt: dates.createdAt,
        firstResponseAt: dates.firstResponseAt ?? null,
        resolvedAt: dates.resolvedAt ?? null
      }
    })
    return row
  }

  const reply = (
    storeId: string,
    conversationId: string,
    authorId: string,
    at: Date,
    type?: MessageType
  ) =>
    createMessage(owner, {
      storeId,
      conversationId,
      authorType: AuthorType.AGENT,
      authorId,
      createdAt: at,
      ...(type === undefined ? {} : { type })
    })

  // The case runs at several hours of the clock (only `Date` is faked, the timers of the database driver are real): what
  // it expects of the day of the store must hold at any minute of the hour, not only in the first half of it
  afterEach(() => jest.useRealTimers())
  // The instant of the clock and the local midnight of the store at it, written out: the zone is the one where it is
  // between 12:00 and 13:00 (so the midnight is 12 hours before the start of the UTC hour), never the UTC midnight
  const CASES: [at: string, dayStart: string][] = [
    ['2026-03-10T00:05:00Z', '2026-03-09T12:00:00.000Z'],
    ['2026-03-10T06:31:00Z', '2026-03-09T18:00:00.000Z'],
    ['2026-03-10T15:32:00Z', '2026-03-10T03:00:00.000Z'],
    ['2026-03-10T23:59:30Z', '2026-03-10T11:00:00.000Z']
  ]
  it.each(CASES)(
    'counts what the person resolved today, what they have open and how fast they answered first (at %s)',
    async (at, dayStart) => {
      jest.useFakeTimers({
        now: new Date(at),
        doNotFake: [
          'nextTick',
          'setImmediate',
          'clearImmediate',
          'setInterval',
          'clearInterval',
          'setTimeout',
          'clearTimeout',
          'queueMicrotask',
          'performance',
          'hrtime'
        ]
      })
      const now = Date.now()
      const { id: storeId } = await aStore(new Date(now))
      const earlier = new Date(now - 10 * MINUTE)
      // Mine, answered by me in 2 minutes and resolved now
      const mine = await conversation(storeId, {
        createdAt: new Date(earlier.getTime() - 2 * MINUTE),
        firstResponseAt: earlier,
        resolvedAt: new Date(now - MINUTE),
        assignedTo: ctx.agentA.id,
        status: ConversationStatus.RESOLVED
      })
      await reply(storeId, mine.id, ctx.agentA.id, earlier)
      // Mine too, but the first reply was another agent's: it is not my response time
      const taken = await conversation(storeId, {
        createdAt: new Date(earlier.getTime() - 8 * MINUTE),
        firstResponseAt: earlier,
        assignedTo: ctx.agentA.id,
        status: ConversationStatus.OPEN
      })
      await reply(storeId, taken.id, ctx.adminA.id, earlier)
      await reply(storeId, taken.id, ctx.agentA.id, new Date(earlier.getTime() + MINUTE))
      // An internal note of mine before the reply of someone else is not a reply
      const note = await conversation(storeId, {
        createdAt: new Date(earlier.getTime() - 4 * MINUTE),
        firstResponseAt: earlier,
        assignedTo: ctx.agentA.id,
        status: ConversationStatus.PENDING
      })
      await reply(
        storeId,
        note.id,
        ctx.agentA.id,
        new Date(earlier.getTime() - MINUTE),
        MessageType.INTERNAL_NOTE
      )
      await reply(storeId, note.id, ctx.adminA.id, earlier)
      // Another person's resolved today, and mine resolved long ago
      await conversation(storeId, {
        createdAt: new Date(now - 3 * HOUR),
        resolvedAt: new Date(now - MINUTE),
        assignedTo: ctx.adminA.id,
        status: ConversationStatus.RESOLVED
      })
      await conversation(storeId, {
        createdAt: new Date(now - 72 * HOUR),
        resolvedAt: new Date(now - 48 * HOUR),
        assignedTo: ctx.agentA.id,
        status: ConversationStatus.RESOLVED
      })

      const response = await api(app, ctx.agentA, { id: storeId }).get(
        ApiRoutes.analytics.myPerformance
      )

      expect(response.status).toBe(200)
      const body = response.body as Body
      expect(body.resolved).toBe(1)
      expect(body.open).toBe(2) // the open one and the pending one
      expect(body.answered).toBe(1)
      expect(body.medianFirstResponseSeconds).toBeCloseTo(120, 0)
      expect(body.dayStart).toBe(dayStart)
    },
    30_000
  )

  it('has no response time before the person has answered anyone today', async () => {
    const { id: storeId } = await aStore(new Date())

    const response = await api(app, ctx.agentA, { id: storeId }).get(
      ApiRoutes.analytics.myPerformance
    )

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      resolved: 0,
      open: 0,
      answered: 0,
      medianFirstResponseSeconds: null
    })
  })

  it('never shows the figures of a store the person does not belong to', async () => {
    const response = await api(app, ctx.agentA, ctx.storeB).get(ApiRoutes.analytics.myPerformance)

    expect(response.status).toBe(403)
  })

  it('is read with the permission to see conversations, not the one of the dashboard', async () => {
    const agent = await api(app, ctx.agentA, ctx.storeA).get(ApiRoutes.analytics.metrics)
    const mine = await api(app, ctx.agentA, ctx.storeA).get(ApiRoutes.analytics.myPerformance)

    expect(agent.status).toBe(403)
    expect(mine.status).toBe(200)
  })
})
