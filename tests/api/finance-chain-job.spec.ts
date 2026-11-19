import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'
import type { PinoLogger } from 'nestjs-pino'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { JobContext, PrismaService } from '@platform/core/database'
import { connectionUrls, type OwnerClient } from '@platform/core/database-testing'
import {
  ChainIncidentChange,
  ChainProblem,
  FinanceConflicts,
  FinanceCountryCodes,
  JournalEntryType
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import {
  FinanceChainMonitor,
  FinanceChainVerifier,
  FinanceCloseGuard
} from '@platform/core/finance-ledger'
import {
  JobNames,
  QueueNames,
  requestedVerifyLedgerChainJobId,
  verifyLedgerChainJobId
} from '@platform/core/queues'

import { FinanceChainChecker } from '../../apps/worker/src/finance/finance-chain-checker.service'
import { verifyLedgerChainJobSchema } from '../../apps/worker/src/processors/heavy-processing.processor'
import { FinanceChainScheduler } from '../../apps/worker/src/schedulers/finance-chain.scheduler'
import { tamperWithLedger } from '../builders/finance'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { CapturedQueue, queueOf } from '../helpers/queue'

const CREATED = 201
const ACCEPTED = 202
const FORBIDDEN = 403
const CONFLICT = 409
const TOO_MANY = 429
const START = '2026-01-01'
const CASH = '1101'
const RENT = '6105'

// The weekly check of the hash chain (TDD_18 §11, Step 4B.8b-2): an alteration opens ONE incident, tells once, stops the close of that
// organization and of no other, and a check that passes closes it again. Nothing here repairs the journal.
describe('The weekly check of the chain, its incident and the guard of the close', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  // The monitor of the weekly job, on the connection of the worker (the only role that may close an incident), and the one of the api
  let monitor: FinanceChainMonitor
  let apiMonitor: FinanceChainMonitor
  let workerDb: PrismaService
  let workerEvents: DomainEvents
  let guard: FinanceCloseGuard
  let published: { event: string; payload: unknown }[] = []

  const logger = {
    setContext: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined
  } as unknown as PinoLogger

  async function manual(user: TestContext['adminA'], store: TestContext['storeA'], org: string) {
    const rows = await owner.ledgerAccount.findMany({
      where: { organizationId: org, code: { in: [CASH, RENT] } },
      select: { id: true, code: true }
    })
    const id = (code: string): string => rows.find(row => row.code === code)?.id ?? ''
    const response = await api(app, user, store)
      .post(ApiRoutes.finance.entries.manual)
      .send({
        idempotencyKey: `k-${randomUUID()}`,
        entryDate: '2026-01-15',
        type: JournalEntryType.MANUAL,
        memo: 'Original memo',
        lines: [
          { accountId: id(RENT), debitCents: 500 },
          { accountId: id(CASH), creditCents: 500 }
        ]
      })
    expect(response.status).toBe(CREATED)
  }

  // The last entry of the organization (the one this suite posted, with the memo 'Original memo'): its memo is what the hash covers here
  const firstMemo = (organizationId: string, memo: string): string =>
    `UPDATE journal_entries SET memo = '${memo}' WHERE organization_id = '${organizationId}' AND number = (SELECT MAX(number) FROM journal_entries WHERE organization_id = '${organizationId}')`
  const openIncidents = (organizationId: string) =>
    owner.financeChainIncident.findMany({ where: { organizationId, resolvedAt: null } })
  const chainEvents = () => published.filter(item => item.event === Events.FINANCE_CHAIN_BROKEN)

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    apiMonitor = app.get(FinanceChainMonitor)
    workerDb = new PrismaService({ databaseUrl: connectionUrls().worker })
    // The events of the worker are tied to the connection of the worker: a transaction opened there is not one of the api's PrismaService
    workerEvents = new DomainEvents(workerDb, app.get(EventEmitter2), logger, {
      publish: () => undefined
    } as never)
    monitor = new FinanceChainMonitor(
      workerDb,
      app.get(FinanceChainVerifier),
      workerEvents,
      { set: () => undefined } as never,
      logger,
      new JobContext(workerDb)
    )
    guard = app.get(FinanceCloseGuard)
    for (const [user, store] of [
      [ctx.adminA, ctx.storeA],
      [ctx.adminB, ctx.storeB]
    ] as const) {
      const setup = await api(app, user, store)
        .post(ApiRoutes.finance.setup)
        .send({ countryCode: FinanceCountryCodes.EL_SALVADOR, accountingStartDate: START })
      expect(setup.status).toBe(CREATED)
    }
    await manual(ctx.adminA, ctx.storeA, ctx.orgA.id)
    await manual(ctx.adminB, ctx.storeB, ctx.orgB.id)
    const original = workerEvents.publish.bind(workerEvents)
    jest.spyOn(workerEvents, 'publish').mockImplementation((tx, event, payload) => {
      published.push({ event: String(event), payload })
      return original(tx, event, payload)
    })
  })
  afterAll(async () => {
    jest.restoreAllMocks()
    await cleanUp(owner, prefix)
    await app.close()
    await workerDb.onModuleDestroy()
    await owner.$disconnect()
  })
  beforeEach(() => {
    published = []
  })

  it('leaves a sound chain alone: no incident, no notice, the close is not blocked', async () => {
    const result = await monitor.check(ctx.orgA.id, { resolve: true })

    expect(result.verification.ok).toBe(true)
    expect(result.incident).toBe(ChainIncidentChange.NONE)
    expect(await openIncidents(ctx.orgA.id)).toEqual([])
    expect(chainEvents()).toEqual([])
    expect((await guard.check(ctx.orgA.id)).chainBroken).toBe(false)
  })

  it('opens one incident when an entry was changed, tells once, and keeps telling nothing while it stays open', async () => {
    await tamperWithLedger(owner, [firstMemo(ctx.orgA.id, 'Rewritten')])

    const first = await monitor.check(ctx.orgA.id, { resolve: true })
    const again = await monitor.check(ctx.orgA.id, { resolve: true })

    expect(first.incident).toBe(ChainIncidentChange.OPENED)
    expect(first.verification.break?.reason).toBe(ChainProblem.HASH_MISMATCH)
    expect(again.incident).toBe(ChainIncidentChange.STILL_OPEN)
    const open = await openIncidents(ctx.orgA.id)
    expect(open).toHaveLength(1)
    const firstEntry = await owner.journalEntry.findFirstOrThrow({
      where: { organizationId: ctx.orgA.id },
      orderBy: { number: 'desc' },
      select: { number: true }
    })
    expect(open[0]).toMatchObject({
      reason: ChainProblem.HASH_MISMATCH,
      entryNumber: firstEntry.number.toString()
    })
    // One notice for the incident, ids and a code only
    expect(chainEvents()).toEqual([
      {
        event: Events.FINANCE_CHAIN_BROKEN,
        payload: { organizationId: ctx.orgA.id, reason: ChainProblem.HASH_MISMATCH }
      }
    ])
  })

  it('stops the close of that organization and of no other', async () => {
    expect((await guard.check(ctx.orgA.id)).chainBroken).toBe(true)
    expect((await guard.check(ctx.orgA.id)).blocked).toBe(true)
    // The books of the other organization are sound and its incident list is empty: nothing of A reaches it
    expect(await openIncidents(ctx.orgB.id)).toEqual([])
    const other = await guard.check(ctx.orgB.id)
    expect(other.chainBroken).toBe(false)

    const january = await owner.fiscalPeriod.findFirstOrThrow({
      where: { organizationId: ctx.orgA.id, year: 2026, month: 1 }
    })
    const response = await api(app, ctx.adminA, ctx.storeA)
      .post(ApiRoutes.finance.periods.close(january.id))
      .send({})
    expect((response.body as { error: { code: string } }).error.code).toBe(
      ErrorCodes.FINANCE_CLOSE_CHAIN_BROKEN
    )
    expect((await owner.fiscalPeriod.findUniqueOrThrow({ where: { id: january.id } })).status).toBe(
      'open'
    )
  })

  it('opens one incident when two checks find the break at the same time', async () => {
    await owner.financeChainIncident.updateMany({
      where: { organizationId: ctx.orgA.id, resolvedAt: null },
      data: { resolvedAt: new Date() }
    })
    const results = await Promise.all([
      monitor.check(ctx.orgA.id, { resolve: true }),
      monitor.check(ctx.orgA.id, { resolve: true })
    ])

    expect(results.map(result => result.incident).sort()).toEqual(
      [ChainIncidentChange.OPENED, ChainIncidentChange.STILL_OPEN].sort()
    )
    expect(await openIncidents(ctx.orgA.id)).toHaveLength(1)
  })

  it('closes the incident when the chain verifies again, and the close is open again', async () => {
    await tamperWithLedger(owner, [firstMemo(ctx.orgA.id, 'Original memo')])

    const result = await monitor.check(ctx.orgA.id, { resolve: true })

    expect(result.verification.ok).toBe(true)
    expect(result.incident).toBe(ChainIncidentChange.RESOLVED)
    expect(await openIncidents(ctx.orgA.id)).toEqual([])
    expect((await guard.check(ctx.orgA.id)).chainBroken).toBe(false)
    // The record stays: who looks later can see that it happened and when it was cleared
    expect(
      await owner.financeChainIncident.count({ where: { organizationId: ctx.orgA.id } })
    ).toBeGreaterThanOrEqual(2)
  })

  it("leaves the incident open when the check is the auditor's (resolve: false): only the job closes it", async () => {
    // An incident is open (the job found the break), and then the chain verifies again
    await tamperWithLedger(owner, [firstMemo(ctx.orgA.id, 'Rewritten for the auditor')])
    expect((await monitor.check(ctx.orgA.id, { resolve: true })).incident).toBe(
      ChainIncidentChange.OPENED
    )
    await tamperWithLedger(owner, [firstMemo(ctx.orgA.id, 'Original memo')])

    const result = await apiMonitor.check(ctx.orgA.id, { resolve: false })

    expect(result.verification.ok).toBe(true)
    expect(result.incident).toBe(ChainIncidentChange.STILL_OPEN)
    expect(await openIncidents(ctx.orgA.id)).toHaveLength(1)
    // The next check of the job (the default) closes it
    expect((await monitor.check(ctx.orgA.id, { resolve: true })).incident).toBe(
      ChainIncidentChange.RESOLVED
    )
  })

  it('opens an incident for a head that does not follow the last entry (a tail cut off behind the application)', async () => {
    await tamperWithLedger(owner, [
      `UPDATE finance_settings SET last_entry_hash = 'cut' WHERE organization_id = '${ctx.orgB.id}'`
    ])
    const result = await monitor.check(ctx.orgB.id, { resolve: true })
    expect(result.incident).toBe(ChainIncidentChange.OPENED)
    expect(result.verification.break?.reason).toBe(ChainProblem.HEAD_MISMATCH)
    // The incident of B does not block A
    expect((await guard.check(ctx.orgA.id)).chainBroken).toBe(false)
    await tamperWithLedger(owner, [
      `UPDATE finance_settings SET last_entry_hash = (SELECT hash FROM journal_entries WHERE organization_id = '${ctx.orgB.id}' ORDER BY number DESC LIMIT 1) WHERE organization_id = '${ctx.orgB.id}'`
    ])
    expect((await monitor.check(ctx.orgB.id, { resolve: true })).incident).toBe(
      ChainIncidentChange.RESOLVED
    )
  })

  describe('the job of the worker', () => {
    it('sets the gauge to one while the chain is altered and back to zero when it verifies, whoever ran the check', async () => {
      const values: { labels: Record<string, string>; value: number }[] = []
      const counting = new FinanceChainMonitor(
        workerDb,
        app.get(FinanceChainVerifier),
        workerEvents,
        {
          set: (labels: Record<string, string>, value: number) => values.push({ labels, value })
        } as never,
        logger,
        new JobContext(workerDb)
      )
      const checker = new FinanceChainChecker(
        counting,
        logger,
        app.get(AuditService, { strict: false })
      )
      await tamperWithLedger(owner, [firstMemo(ctx.orgA.id, 'Rewritten again')])
      await checker.check(ctx.orgA.id)
      await tamperWithLedger(owner, [firstMemo(ctx.orgA.id, 'Original memo')])
      await checker.check(ctx.orgA.id)

      expect(values).toEqual([
        { labels: { organization_id: ctx.orgA.id }, value: 1 },
        { labels: { organization_id: ctx.orgA.id }, value: 0 }
      ])
    })

    it('queues one check for each organization with books, with an id of its own for the day', async () => {
      const heavy = new CapturedQueue()
      const locks = {
        withLock: async (_name: string, _seconds: number, work: () => Promise<void>) => {
          await work()
          return true
        }
      } as never
      const scheduler = new FinanceChainScheduler(
        locks,
        heavy as never,
        workerDb,
        logger,
        new JobContext(workerDb)
      )
      await scheduler.enqueueAll(new Date('2026-11-15T05:00:00.000Z'), { pageSize: 1 })
      const mine = heavy.jobs.filter(
        job => (job.data as { organizationId: string }).organizationId === ctx.orgA.id
      )
      expect(mine).toEqual([
        {
          name: JobNames.VERIFY_LEDGER_CHAIN,
          data: { organizationId: ctx.orgA.id },
          opts: {
            jobId: verifyLedgerChainJobId(ctx.orgA.id, '2026-11-15'),
            attempts: 3,
            backoff: { type: 'exponential', delay: 60_000 },
            removeOnFail: true
          }
        }
      ])
      const ids = heavy.jobs.map(job => job.opts?.jobId)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('does not throw when the queue is down: the next week tries again', async () => {
      const broken = { addBulk: () => Promise.reject(new Error('redis is down')) }
      const failing = new FinanceChainScheduler(
        {
          withLock: async (_n: string, _s: number, work: () => Promise<void>) => {
            await work()
            return true
          }
        } as never,
        broken as never,
        workerDb,
        logger,
        new JobContext(workerDb)
      )
      await expect(failing.run()).resolves.toBeUndefined()
    })
  })
  // N-B8-1: the api role cannot close an incident, so a person asks the worker, which walks the chain again and decides
  describe('asking the worker to close an incident', () => {
    const heavy = () => queueOf(app, QueueNames.HEAVY_PROCESSING)
    const asked = (org: string) =>
      heavy().jobs.filter(
        job =>
          job.name === JobNames.VERIFY_LEDGER_CHAIN &&
          (job.data as { organizationId: string }).organizationId === org &&
          (job.data as { requestedBy?: string }).requestedBy !== undefined
      )
    const openIncidentFor = (organizationId: string) =>
      owner.financeChainIncident.create({
        data: {
          organizationId,
          reason: ChainProblem.HASH_MISMATCH,
          entriesChecked: 1,
          lastSeenAt: new Date()
        }
      })
    const resolveAll = (organizationId: string) =>
      owner.financeChainIncident.updateMany({
        where: { organizationId, resolvedAt: null },
        data: { resolvedAt: new Date() }
      })

    it('refuses a member without the right to close periods', async () => {
      await resolveAll(ctx.orgA.id)
      await openIncidentFor(ctx.orgA.id)

      const response = await api(app, ctx.agentA, ctx.storeA).post(
        ApiRoutes.finance.reports.resolveChain
      )

      expect(response.status).toBe(FORBIDDEN)
      expect(asked(ctx.orgA.id)).toEqual([])
      await resolveAll(ctx.orgA.id)
    })

    it('refuses when no incident is open', async () => {
      await resolveAll(ctx.orgB.id)

      const response = await api(app, ctx.adminB, ctx.storeB).post(
        ApiRoutes.finance.reports.resolveChain
      )

      expect(response.status).toBe(CONFLICT)
      expect(
        (response.body as { error: { metadata?: { conflict?: string } } }).error.metadata?.conflict
      ).toBe(FinanceConflicts.CHAIN_NO_OPEN_INCIDENT)
      expect(asked(ctx.orgB.id)).toEqual([])
    })

    it('queues one check for the organization of the caller, audits who asked, and never closes the incident itself', async () => {
      await resolveAll(ctx.orgA.id)
      await resolveAll(ctx.orgB.id)
      await openIncidentFor(ctx.orgB.id)

      const first = await api(app, ctx.adminB, ctx.storeB).post(
        ApiRoutes.finance.reports.resolveChain
      )

      expect(first.status).toBe(ACCEPTED)
      const jobs = asked(ctx.orgB.id)
      expect(jobs).toHaveLength(1)
      expect(jobs[0]?.opts?.jobId).toBe(requestedVerifyLedgerChainJobId(ctx.orgB.id))
      expect(jobs[0]?.data).toEqual({ organizationId: ctx.orgB.id, requestedBy: ctx.adminB.id })
      // Asked again while the job of the first is still in the queue (the real queue keeps it for the cooldown): a 429, no second job and
      // no second audit row
      jest.spyOn(heavy(), 'getJob').mockResolvedValueOnce({ id: 'x' } as never)
      const again = await api(app, ctx.adminB, ctx.storeB).post(
        ApiRoutes.finance.reports.resolveChain
      )
      expect(again.status).toBe(TOO_MANY)
      expect(asked(ctx.orgB.id)).toHaveLength(1)
      // The api did not close it: that is the worker's, and the api role has no right to
      expect(await openIncidents(ctx.orgB.id)).toHaveLength(1)
      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.FINANCE_CHAIN_RESOLVE_REQUESTED,
        resourceId: ctx.orgB.id
      })
      expect(entries).toHaveLength(1)
      expect(entries[0]?.userId).toBe(ctx.adminB.id)
      // Nothing was asked for the other organization
      expect(asked(ctx.orgA.id)).toEqual([])
    })

    it('is closed by the job of the worker when the chain verifies, and stays open when it does not', async () => {
      const checker = new FinanceChainChecker(
        monitor,
        logger,
        app.get(AuditService, { strict: false })
      )
      await resolveAll(ctx.orgB.id)
      await tamperWithLedger(owner, [firstMemo(ctx.orgB.id, 'Rewritten')])
      const broken = await checker.check(ctx.orgB.id, new Date(), ctx.adminB.id)
      expect(broken.verification.ok).toBe(false)
      expect(await openIncidents(ctx.orgB.id)).toHaveLength(1)

      await tamperWithLedger(owner, [firstMemo(ctx.orgB.id, 'Original memo')])
      const sound = await checker.check(ctx.orgB.id, new Date(), ctx.adminB.id)

      expect(sound.verification.ok).toBe(true)
      expect(sound.incident).toBe(ChainIncidentChange.RESOLVED)
      expect(await openIncidents(ctx.orgB.id)).toEqual([])
      // Each check a person asked for leaves a row with who asked and what it found, the one that closed it included
      const checked = await waitForAuditEntries(
        owner,
        { action: AuditAction.FINANCE_CHAIN_RESOLVE_CHECKED, resourceId: ctx.orgB.id },
        2
      )
      expect(checked.map(entry => entry.userId)).toEqual([ctx.adminB.id, ctx.adminB.id])
      expect(checked.map(entry => (entry.metadata as { incident: string }).incident)).toEqual([
        ChainIncidentChange.OPENED,
        ChainIncidentChange.RESOLVED
      ])
    })

    it('reads the job a person asked for with who asked, and still reads the weekly one without', () => {
      const asker = randomUUID()

      expect(
        verifyLedgerChainJobSchema.safeParse({ organizationId: ctx.orgB.id, requestedBy: asker })
          .success
      ).toBe(true)
      expect(verifyLedgerChainJobSchema.safeParse({ organizationId: ctx.orgB.id }).success).toBe(
        true
      )
      expect(
        verifyLedgerChainJobSchema.safeParse({ organizationId: ctx.orgB.id, requestedBy: 'x' })
          .success
      ).toBe(false)
    })
  })
})
