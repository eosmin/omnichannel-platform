import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import type { PinoLogger } from 'nestjs-pino'

import { ApiRoutes } from '@platform/core/api'
import { PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  ChainIncidentChange,
  ChainProblem,
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
import { JobNames, verifyLedgerChainJobId } from '@platform/core/queues'

import { FinanceChainChecker } from '../../apps/worker/src/finance/finance-chain-checker.service'
import { FinanceChainScheduler } from '../../apps/worker/src/schedulers/finance-chain.scheduler'
import { tamperWithLedger } from '../builders/finance'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { CapturedQueue } from '../helpers/queue'

const CREATED = 201
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
  let monitor: FinanceChainMonitor
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
    monitor = app.get(FinanceChainMonitor)
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
    const events = app.get(DomainEvents)
    const original = events.publish.bind(events)
    jest.spyOn(events, 'publish').mockImplementation((tx, event, payload) => {
      published.push({ event: String(event), payload })
      return original(tx, event, payload)
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

  it('leaves a sound chain alone: no incident, no notice, the close is not blocked', async () => {
    const result = await monitor.check(ctx.orgA.id)

    expect(result.verification.ok).toBe(true)
    expect(result.incident).toBe(ChainIncidentChange.NONE)
    expect(await openIncidents(ctx.orgA.id)).toEqual([])
    expect(chainEvents()).toEqual([])
    expect((await guard.check(ctx.orgA.id)).chainBroken).toBe(false)
  })

  it('opens one incident when an entry was changed, tells once, and keeps telling nothing while it stays open', async () => {
    await tamperWithLedger(owner, [firstMemo(ctx.orgA.id, 'Rewritten')])

    const first = await monitor.check(ctx.orgA.id)
    const again = await monitor.check(ctx.orgA.id)

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
    const results = await Promise.all([monitor.check(ctx.orgA.id), monitor.check(ctx.orgA.id)])

    expect(results.map(result => result.incident).sort()).toEqual(
      [ChainIncidentChange.OPENED, ChainIncidentChange.STILL_OPEN].sort()
    )
    expect(await openIncidents(ctx.orgA.id)).toHaveLength(1)
  })

  it('closes the incident when the chain verifies again, and the close is open again', async () => {
    await tamperWithLedger(owner, [firstMemo(ctx.orgA.id, 'Original memo')])

    const result = await monitor.check(ctx.orgA.id)

    expect(result.verification.ok).toBe(true)
    expect(result.incident).toBe(ChainIncidentChange.RESOLVED)
    expect(await openIncidents(ctx.orgA.id)).toEqual([])
    expect((await guard.check(ctx.orgA.id)).chainBroken).toBe(false)
    // The record stays: who looks later can see that it happened and when it was cleared
    expect(
      await owner.financeChainIncident.count({ where: { organizationId: ctx.orgA.id } })
    ).toBeGreaterThanOrEqual(2)
  })

  it('opens an incident for a head that does not follow the last entry (a tail cut off behind the application)', async () => {
    await tamperWithLedger(owner, [
      `UPDATE finance_settings SET last_entry_hash = 'cut' WHERE organization_id = '${ctx.orgB.id}'`
    ])
    const result = await monitor.check(ctx.orgB.id)
    expect(result.incident).toBe(ChainIncidentChange.OPENED)
    expect(result.verification.break?.reason).toBe(ChainProblem.HEAD_MISMATCH)
    // The incident of B does not block A
    expect((await guard.check(ctx.orgA.id)).chainBroken).toBe(false)
    await tamperWithLedger(owner, [
      `UPDATE finance_settings SET last_entry_hash = (SELECT hash FROM journal_entries WHERE organization_id = '${ctx.orgB.id}' ORDER BY number DESC LIMIT 1) WHERE organization_id = '${ctx.orgB.id}'`
    ])
    expect((await monitor.check(ctx.orgB.id)).incident).toBe(ChainIncidentChange.RESOLVED)
  })

  describe('the job of the worker', () => {
    it('sets the gauge to one while the chain is altered and back to zero when it verifies, whoever ran the check', async () => {
      const values: { labels: Record<string, string>; value: number }[] = []
      const counting = new FinanceChainMonitor(
        app.get(PrismaService),
        app.get(FinanceChainVerifier),
        app.get(DomainEvents),
        {
          set: (labels: Record<string, string>, value: number) => values.push({ labels, value })
        } as never,
        logger
      )
      const checker = new FinanceChainChecker(counting, logger)
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
        app.get(PrismaService),
        logger
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
        app.get(PrismaService),
        logger
      )
      await expect(failing.run()).resolves.toBeUndefined()
    })
  })
})
