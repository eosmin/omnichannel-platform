import type { INestApplication } from '@nestjs/common'
import type { PinoLogger } from 'nestjs-pino'

import { ApiRoutes } from '@platform/core/api'
import { JobContext, JobContextError, PrismaService } from '@platform/core/database'
import { connectionUrls, type OwnerClient } from '@platform/core/database-testing'
import { FinanceCountryCodes, FinanceEventKind, FinanceSourceType } from '@platform/core/domain'
import {
  FinanceChainMonitor,
  FinancePostingService,
  FinanceSweepService
} from '@platform/core/finance-ledger'

import { FinanceReconcileScheduler } from '../../apps/worker/src/schedulers/finance-reconcile.scheduler'
import { createOrder } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { CapturedQueue } from '../helpers/queue'

const CREATED = 201
const TODAY = new Date().toISOString().slice(0, 10)

// RLS phase 5, PR D1: the books and the checks of the worker run inside the context of ONE organization, one unit of work at a time.
// The worker role still skips row security, so what proves "every access is in a context" is the guard of PrismaService
// (`requireContext`, the flag WORKER_RLS_CONTEXT): a query behind row security with no context throws instead of reading no row.
// The services come from an app whose database is the worker role with the guard ON; the books are set up through a plain app.
describe('RLS phase 5: the books of the worker run in the context of their organization', () => {
  const prefix = newRunPrefix()
  let setupApp: INestApplication
  let app: INestApplication
  let guarded: PrismaService
  let owner: OwnerClient
  let ctx: TestContext
  let sweep: FinanceSweepService
  let posting: FinancePostingService
  let monitor: FinanceChainMonitor
  let jobs: JobContext
  let withoutBooks: string

  beforeAll(async () => {
    owner = ownerClient()
    setupApp = await createTestApp()
    ctx = await seedTestContext(owner, setupApp, prefix)
    for (const [user, store] of [
      [ctx.adminA, ctx.storeA],
      [ctx.adminB, ctx.storeB]
    ] as const) {
      const setup = await api(setupApp, user, store)
        .post(ApiRoutes.finance.setup)
        .send({ countryCode: FinanceCountryCodes.EL_SALVADOR, accountingStartDate: '2020-01-01' })
      expect(setup.status).toBe(CREATED)
    }
    // An organization that never set up its books
    const bare = await owner.organization.create({
      data: { name: `${prefix}-bare`, slug: `${prefix}-bare` }
    })
    withoutBooks = bare.id

    guarded = new PrismaService({
      databaseUrl: connectionUrls().worker,
      poolSize: 8,
      requireContext: true
    })
    app = await createTestApp([], builder =>
      builder.overrideProvider(PrismaService).useValue(guarded)
    )
    sweep = app.get(FinanceSweepService)
    posting = app.get(FinancePostingService)
    monitor = app.get(FinanceChainMonitor)
    jobs = app.get(JobContext)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await owner.organization.deleteMany({ where: { id: withoutBooks } })
    await app.close()
    await setupApp.close()
    await owner.$disconnect()
  })

  async function deliveredOrder(storeId: string): Promise<string> {
    const made = await createOrder(owner, { storeId })
    await owner.order.update({
      where: { id: made.id },
      data: {
        status: 'DELIVERED',
        subtotalCents: 2260,
        shippingCents: 565,
        discountCents: 0,
        totalCents: 2825,
        taxCents: 325,
        pricesIncludeTax: true,
        paymentMethod: 'CASH_ON_DELIVERY',
        paymentStatus: 'PENDING',
        shippedAt: new Date(`${TODAY}T18:00:00Z`),
        deliveredAt: new Date(`${TODAY}T18:00:00Z`)
      }
    })
    return made.id
  }

  it('the guard is on: a read of the books with no context is refused, not answered with no row', async () => {
    await expect(
      guarded.client.financeSettings.findUnique({ where: { organizationId: ctx.orgA.id } })
    ).rejects.toThrow(/no tenant context/)
  })

  it('the sweep, the balances and the stock comparison open their own context and find the sources of the organization', async () => {
    const orderId = await deliveredOrder(ctx.storeA.id)
    const swept = await sweep.sweep(ctx.orgA.id)
    expect(swept.toQueue.filter(job => job.sourceId === orderId)).toHaveLength(1)
    await expect(sweep.balanceMismatches(ctx.orgA.id)).resolves.toEqual(expect.any(Number))
    const drift = await sweep.inventoryDrift(ctx.orgA.id)
    expect(typeof drift.differenceCents).toBe('bigint')
    // Nothing stays open after the work: the next read with no context is refused again
    expect(jobs.isOpen()).toBe(false)
    expect(guarded.hasTenantContext()).toBe(false)
  })

  it('a posting is one unit in the context of its organization: the entry, its trigger-driven head and a replay', async () => {
    const orderId = await deliveredOrder(ctx.storeA.id)
    const input = {
      organizationId: ctx.orgA.id,
      sourceType: FinanceSourceType.ORDER,
      sourceId: orderId,
      kind: FinanceEventKind.SALE
    }
    const preview = await posting.preview(input)
    expect(preview.outcome).toBeDefined()
    const first = await posting.post(input)
    const again = await posting.post(input)
    // Posted or recorded as a failure a person fixes, and the second run is the same answer, never a second entry
    expect(again.entryId).toBe(first.entryId)
    // The chain still verifies after a posting made by the worker under the context (the head trigger saw its own rows)
    const check = await monitor.check(ctx.orgA.id, { resolve: false })
    expect(check.verification.ok).toBe(true)
  })

  it('the context of one organization is refused for another while it is open', async () => {
    await jobs.inOrganization(ctx.orgA.id, async () => {
      await expect(
        jobs.inOrganization(ctx.orgB.id, () => Promise.resolve(undefined))
      ).rejects.toBeInstanceOf(JobContextError)
    })
  })

  it('the checks of an organization with no books end without an error and the schedulers skip it', async () => {
    await expect(sweep.sweep(withoutBooks)).resolves.toEqual(
      expect.objectContaining({ examined: 0, toQueue: [] })
    )
    const heavy = new CapturedQueue()
    const scheduler = new FinanceReconcileScheduler(
      {
        withLock: async (_n: string, _s: number, work: () => Promise<void>) => (await work(), true)
      } as never,
      heavy as never,
      guarded,
      {
        setContext: () => undefined,
        error: () => undefined,
        info: () => undefined
      } as unknown as PinoLogger,
      jobs
    )
    await scheduler.enqueueAll(new Date(`${TODAY}T04:30:00Z`), { pageSize: 1 })
    const queued = heavy.jobs.map(job => (job.data as { organizationId: string }).organizationId)
    expect(queued).toEqual(expect.arrayContaining([ctx.orgA.id, ctx.orgB.id]))
    expect(queued).not.toContain(withoutBooks)
  })
})
