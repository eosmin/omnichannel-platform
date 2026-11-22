import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import type { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { ComplianceConfig } from '@platform/core/compliance'
import { JobContext } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import { DAY_MS, DsrStatus, DsrType } from '@platform/core/domain'
import type { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'

import { DsrDeadlineChecker } from '../../apps/worker/src/compliance/dsr-deadline.checker'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { createGuardedWorkerPrisma } from '../helpers/worker-db'

const ALERT_AFTER_DAYS = ComplianceConfig.DSR_DEADLINE_ALERT_DAY

// Step 7.2-H2b-2: the alert of day 25 against the REAL database as the (guarded) role of the worker. A request that is still open when only a
// few days of its legal deadline are left tells the reviewers, once; one that ended, one that was never verified and one of another store do not.
describe('the alert of the data requests that are close to their deadline', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let checker: DsrDeadlineChecker
  const published: {
    event: string
    payload: { requestId: string; storeId: string; daysLeft: number }
  }[] = []
  let realAudit: AuditService
  const audit = {
    log: jest.fn<void, [Parameters<AuditService['log']>[0]]>(entry => realAudit.log(entry))
  }
  const logger = { setContext: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() }

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp([])
    ctx = await seedTestContext(owner, app, prefix)
    const prisma = createGuardedWorkerPrisma()
    realAudit = new AuditService(prisma, logger as unknown as PinoLogger)
    const events = {
      publish: (_tx: unknown, event: string, payload: never) => {
        published.push({ event, payload })
      }
    } as unknown as DomainEvents
    checker = new DsrDeadlineChecker(
      prisma,
      new JobContext(prisma),
      audit as unknown as AuditService,
      events,
      logger as unknown as PinoLogger
    )
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(() => {
    published.length = 0
    audit.log.mockClear()
  })

  // A request made `ageDays` ago, whose deadline is the legal one from then
  async function request(input: {
    storeId?: string
    organizationId?: string
    status: string
    ageDays: number
    alerted?: boolean
  }): Promise<string> {
    const requestedAt = new Date(Date.now() - input.ageDays * DAY_MS)
    const row = await owner.dataSubjectRequest.create({
      data: {
        organizationId: input.organizationId ?? ctx.orgA.id,
        storeId: input.storeId ?? ctx.storeA.id,
        type: DsrType.ACCESS,
        status: input.status,
        subjectType: 'customer',
        notes: randomUUID(),
        requestedAt,
        deadlineAt: new Date(
          requestedAt.getTime() + ComplianceConfig.DSR_RESPONSE_DEADLINE_DAYS * DAY_MS
        ),
        ...(input.alerted === true ? { deadlineAlertSentAt: new Date() } : {})
      },
      select: { id: true }
    })
    return row.id
  }
  const alertsOf = (id: string) =>
    published.filter(
      item => item.event === Events.DSR_DEADLINE_APPROACHING && item.payload.requestId === id
    )

  it('alerts the reviewers once for an open request that reached day 25, with the days that are left', async () => {
    const id = await request({ status: DsrStatus.MANUAL_REVIEW, ageDays: ALERT_AFTER_DAYS + 0.1 })

    await checker.run()
    await checker.run()

    expect(alertsOf(id)).toHaveLength(1)
    expect(alertsOf(id)[0]?.payload).toMatchObject({ storeId: ctx.storeA.id })
    expect(alertsOf(id)[0]?.payload.daysLeft).toBeLessThanOrEqual(5)
    expect(
      (await owner.dataSubjectRequest.findUniqueOrThrow({ where: { id } })).deadlineAlertSentAt
    ).not.toBeNull()
    expect(
      await owner.auditLog.count({
        where: { action: AuditAction.DSR_DEADLINE_ALERTED, resourceId: id }
      })
    ).toBe(1)
    // The event and the audit hold ids and a number: no address, no name
    expect(JSON.stringify([...published, ...audit.log.mock.calls])).not.toContain('@')
  })

  it('also alerts for an approved request that is waiting for its sweep', async () => {
    const id = await request({ status: DsrStatus.IN_PROGRESS, ageDays: 27 })

    await checker.run()

    expect(alertsOf(id)).toHaveLength(1)
  })

  it('does not alert before day 25, after the request ended, before it was verified, or twice', async () => {
    const early = await request({ status: DsrStatus.MANUAL_REVIEW, ageDays: ALERT_AFTER_DAYS - 2 })
    const ended = await request({ status: DsrStatus.COMPLETED, ageDays: 28 })
    const rejected = await request({ status: DsrStatus.REJECTED, ageDays: 28 })
    const unverified = await request({ status: DsrStatus.PENDING_VERIFICATION, ageDays: 28 })
    const already = await request({ status: DsrStatus.MANUAL_REVIEW, ageDays: 28, alerted: true })

    await checker.run()

    for (const id of [early, ended, rejected, unverified, already])
      expect(alertsOf(id)).toHaveLength(0)
  })

  it('alerts the stores each for their own requests: the alert names the store of the request', async () => {
    const mine = await request({ status: DsrStatus.MANUAL_REVIEW, ageDays: 28 })
    const sibling = await request({
      storeId: ctx.storeA2.id,
      status: DsrStatus.MANUAL_REVIEW,
      ageDays: 28
    })
    const other = await request({
      storeId: ctx.storeB.id,
      organizationId: ctx.orgB.id,
      status: DsrStatus.MANUAL_REVIEW,
      ageDays: 28
    })

    await checker.run()

    expect(alertsOf(mine)[0]?.payload.storeId).toBe(ctx.storeA.id)
    expect(alertsOf(sibling)[0]?.payload.storeId).toBe(ctx.storeA2.id)
    expect(alertsOf(other)[0]?.payload.storeId).toBe(ctx.storeB.id)
  })

  it('two runs at the same time raise one alert', async () => {
    const id = await request({ status: DsrStatus.MANUAL_REVIEW, ageDays: 28 })

    await Promise.all([checker.run(), checker.run()])

    expect(alertsOf(id)).toHaveLength(1)
  })

  it('raises one alert for each request even when two runs list it before either claims it', async () => {
    const ids = await Promise.all(
      Array.from({ length: 5 }, () => request({ status: DsrStatus.MANUAL_REVIEW, ageDays: 28 }))
    )
    const internals = checker as unknown as {
      checkStore: (storeId: string, now: Date) => Promise<number>
    }

    await Promise.all([
      internals.checkStore(ctx.storeA.id, new Date()),
      internals.checkStore(ctx.storeA.id, new Date())
    ])

    for (const id of ids) expect(alertsOf(id)).toHaveLength(1)
  })
})
