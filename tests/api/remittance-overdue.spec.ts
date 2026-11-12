import { randomUUID } from 'node:crypto'

import { getQueueToken } from '@nestjs/bullmq'
import type { INestApplication } from '@nestjs/common'
import type { PinoLogger } from 'nestjs-pino'

import { ApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import { PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import { AppPaths, CarrierResourceTypes, CodStatus, ShipmentStatus } from '@platform/core/domain'
import { DomainEvents } from '@platform/core/event-bus'
import { NotificationTypes } from '@platform/core/notifications'
import { checkRemittancesJobId, JobNames, QueueNames } from '@platform/core/queues'

import { RemittanceChecker } from '../../apps/worker/src/notifications/remittance-checker.service'
import { RemittanceCheckScheduler } from '../../apps/worker/src/schedulers/remittance-check.scheduler'
import { createCarrierConnection, createShipment } from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { CapturedQueue } from '../helpers/queue'

const DAY_MS = 24 * 60 * 60 * 1000
const OK = 200
const ATTEMPTS = 60
const POLL_MS = 100

// The listener runs after the bus commits: wait for what it must have written instead of reading at once
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let value = await read()
  for (let attempt = 0; attempt < ATTEMPTS && !done(value); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
    value = await read()
  }
  return value
}

// The daily check of the cash that carriers still owe (TDD_17 §4.15, Step 4.13 PR B): the worker finds connections with delivered
// COD packages unpaid for longer than the store allows and raises `remittance.overdue`; the api tells the people who settle
// remittances, at most once a week for each connection.
describe('The daily check of overdue remittances', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let checker: RemittanceChecker
  const pushQueue = new CapturedQueue()
  const NOW = new Date('2026-11-12T15:00:00.000Z')
  const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS)

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp([], builder =>
      builder.overrideProvider(getQueueToken(QueueNames.NOTIFICATIONS)).useValue(pushQueue)
    )
    ctx = await seedTestContext(owner, app, prefix)
    const logger = { setContext: () => undefined, info: () => undefined } as unknown as PinoLogger
    checker = new RemittanceChecker(app.get(PrismaService), app.get(DomainEvents), logger)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  afterEach(async () => {
    // Each test starts with a store that is owed nothing: the check counts every connection of the store
    await owner.shipment.deleteMany({
      where: { storeId: { in: [ctx.storeA.id, ctx.storeA2.id, ctx.storeB.id] } }
    })
    await owner.notification.deleteMany({
      where: { storeId: { in: [ctx.storeA.id, ctx.storeA2.id, ctx.storeB.id] } }
    })
    await owner.storeSettings.updateMany({
      where: { storeId: ctx.storeA.id },
      data: { preferences: {} }
    })
    pushQueue.jobs.length = 0
  })

  const connectionOf = (storeId: string, displayName = `Courier ${randomUUID().slice(0, 8)}`) =>
    createCarrierConnection(owner, {
      storeId,
      displayName,
      prefix: `V${randomUUID().slice(0, 4)}`.toUpperCase()
    })
  const owed = (
    connectionId: string,
    days: number,
    over: Partial<Parameters<typeof createShipment>[1]> = {}
  ) =>
    createShipment(owner, {
      storeId: ctx.storeA.id,
      connectionId,
      status: ShipmentStatus.DELIVERED,
      codAmountCents: 1000,
      codExpectedCents: 1000,
      codStatus: CodStatus.PENDING_REMITTANCE,
      deliveredAt: daysAgo(days),
      ...over
    })
  const rowsOf = () =>
    owner.notification.findMany({
      where: { storeId: ctx.storeA.id, type: NotificationTypes.REMITTANCE_OVERDUE }
    })
  // The listener of an earlier test may still be writing: wait for the row of THIS connection
  const warned = (connectionId: string) =>
    until(
      () =>
        owner.notification.count({ where: { storeId: ctx.storeA.id, resourceId: connectionId } }),
      count => count > 0
    )
  async function manager() {
    return actorWithPermissions(owner, app, {
      prefix,
      name: `remManager${randomUUID().slice(0, 6)}`,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      permissions: [Permissions.REMITTANCES_MANAGE, Permissions.REMITTANCES_VIEW]
    })
  }

  it('tells who settles remittances about a carrier that kept the cash too long, and nobody else', async () => {
    const holder = await manager()
    const viewer = await actorWithPermissions(owner, app, {
      prefix,
      name: `remViewer${randomUUID().slice(0, 6)}`,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      permissions: [Permissions.REMITTANCES_VIEW]
    })
    const connection = await connectionOf(ctx.storeA.id, 'Courier Late')
    await owed(connection.id, 10)
    await owed(connection.id, 9, { codStatus: CodStatus.DISCREPANCY, codRemittedCents: 400 })

    expect(await checker.check(ctx.storeA.id, NOW)).toBe(1)

    // The listener writes a row for each recipient: wait for the one of the holder, then look at who else was told
    await until(
      () => owner.notification.count({ where: { storeId: ctx.storeA.id, userId: holder.id } }),
      count => count > 0
    )
    const rows = await rowsOf()
    const told = rows.map(row => row.userId)
    expect(told).toContain(holder.id)
    expect(told).not.toContain(viewer.id)
    expect(told).not.toContain(ctx.adminB.id)
    expect(rows.find(row => row.userId === holder.id)).toMatchObject({
      resourceType: CarrierResourceTypes.CARRIER_CONNECTION,
      resourceId: connection.id,
      actionPath: AppPaths.store.remittances(ctx.storeA.id),
      params: { carrier: 'Courier Late', count: 2, days: 7 }
    })
  })

  it('leaves alone what is not late, what was paid and what never was cash on delivery', async () => {
    await manager()
    const connection = await connectionOf(ctx.storeA.id)
    await owed(connection.id, 3)
    await owed(connection.id, 30, { codStatus: CodStatus.REMITTED, codRemittedCents: 1000 })
    await owed(connection.id, 30, { codStatus: CodStatus.VOID })
    await createShipment(owner, {
      storeId: ctx.storeA.id,
      connectionId: connection.id,
      status: ShipmentStatus.DELIVERED,
      deliveredAt: daysAgo(30)
    })
    expect(await checker.check(ctx.storeA.id, NOW)).toBe(0)
    expect(await rowsOf()).toHaveLength(0)
  })

  it('uses the days the store chose', async () => {
    await manager()
    const connection = await connectionOf(ctx.storeA.id)
    await owed(connection.id, 3)
    expect(await checker.check(ctx.storeA.id, NOW)).toBe(0)

    const saved = await api(app, ctx.adminA, ctx.storeA)
      .put(ApiRoutes.settings.preferences)
      .send({ remittances: { overdueAfterDays: 2 } })
    expect(saved.status).toBe(OK)
    expect((saved.body as { remittances: { overdueAfterDays: number } }).remittances).toEqual({
      overdueAfterDays: 2
    })
    expect(await checker.check(ctx.storeA.id, NOW)).toBe(1)
    // The listener finishes before the next test starts
    await warned(connection.id)
  })

  it('says it once a week for each connection, and again when the week has passed', async () => {
    await manager()
    const connection = await connectionOf(ctx.storeA.id)
    await owed(connection.id, 20)
    expect(await checker.check(ctx.storeA.id, NOW)).toBe(1)
    await warned(connection.id)
    expect(await checker.check(ctx.storeA.id, new Date(NOW.getTime() + DAY_MS))).toBe(0)
    // Another connection of the same store has its own week
    const other = await connectionOf(ctx.storeA.id)
    await owed(other.id, 20)
    expect(await checker.check(ctx.storeA.id, new Date(NOW.getTime() + DAY_MS))).toBe(1)
    await warned(other.id)

    await owner.notification.updateMany({
      where: { storeId: ctx.storeA.id, resourceId: connection.id },
      data: { createdAt: new Date(NOW.getTime() - 8 * DAY_MS) }
    })
    expect(await checker.check(ctx.storeA.id, new Date(NOW.getTime() + DAY_MS))).toBe(1)
  })

  it('adds what is owed shipment by shipment, so an overpaid package hides no debt', async () => {
    const holder = await manager()
    const connection = await connectionOf(ctx.storeA.id)
    await owed(connection.id, 20, { codStatus: CodStatus.DISCREPANCY, codRemittedCents: 1500 })
    await owed(connection.id, 20)
    expect(await checker.check(ctx.storeA.id, NOW)).toBe(1)
    await until(
      () => owner.notification.count({ where: { storeId: ctx.storeA.id, userId: holder.id } }),
      count => count > 0
    )
    const row = (await rowsOf()).find(entry => entry.userId === holder.id)
    expect(row?.params).toMatchObject({ count: 2 })
  })

  it('does not look at the shipments of another store', async () => {
    const stranger = await connectionOf(ctx.storeB.id)
    await createShipment(owner, {
      storeId: ctx.storeB.id,
      connectionId: stranger.id,
      status: ShipmentStatus.DELIVERED,
      codAmountCents: 500,
      codExpectedCents: 500,
      codStatus: CodStatus.PENDING_REMITTANCE,
      deliveredAt: daysAgo(40)
    })
    expect(await checker.check(ctx.storeA.id, NOW)).toBe(0)
  })

  describe('the daily schedule', () => {
    const locks = {
      withLock: async (_name: string, _seconds: number, work: () => Promise<void>) => {
        await work()
        return true
      }
    } as never
    const logger = { setContext: () => undefined, error: () => undefined } as unknown as PinoLogger
    const queue = new CapturedQueue()

    it('queues one check for each store that is owed cash, named by the store and the day', async () => {
      queue.jobs.length = 0
      const connection = await connectionOf(ctx.storeA.id)
      await owed(connection.id, 1)
      const scheduler = new RemittanceCheckScheduler(
        locks,
        queue as never,
        app.get(PrismaService),
        logger
      )
      const queued = await scheduler.enqueueAll(NOW, { pageSize: 1 })
      const mine = queue.jobs.filter(
        job => (job.data as { storeId: string }).storeId === ctx.storeA.id
      )
      expect(queued).toBeGreaterThanOrEqual(1)
      expect(mine).toHaveLength(1)
      expect(mine[0]).toMatchObject({
        name: JobNames.CHECK_REMITTANCES,
        opts: { jobId: checkRemittancesJobId(ctx.storeA.id, '2026-11-12') }
      })
      expect(
        queue.jobs.some(job => (job.data as { storeId: string }).storeId === ctx.storeA2.id)
      ).toBe(false)
    })
  })
})
