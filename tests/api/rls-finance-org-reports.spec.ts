import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { PrismaService, RLS_CONTEXT_ENABLED } from '@platform/core/database'
import { connectionUrls, type OwnerClient } from '@platform/core/database-testing'
import { FinanceCountryCodes, OrderStatus } from '@platform/core/domain'

import { createOrder } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

interface VatBody {
  ordersWithoutTaxSnapshot: number
  ordersNotReadable: number
}

const OK = 200
const CREATED = 201
const DAY_MS = 86_400_000
const isoDay = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10)

// The reports of the books are the ORGANIZATION's (TDD_18 §7, §10): they read the orders of every store of it. With the switch ON the
// request of a store holds that store alone, so a report that reads `orders` in it saw the sales of one store and changed with the
// header (QA, RLS ON: the VAT of an organization with two stores was 21 375 with the first header and -7 257 with the second). The app
// below is the real one, on the role of the api, with the switch on and a context required for every query.
describe('RLS phase 6: the reports of the books read the orders of every store of the organization', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let guarded: PrismaService
  let owner: OwnerClient
  let ctx: TestContext

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
    const setup = await api(app, ctx.adminA, ctx.storeA)
      .post(ApiRoutes.finance.setup)
      .send({ countryCode: FinanceCountryCodes.EL_SALVADOR, accountingStartDate: '2020-01-01' })
    expect(setup.status).toBe(CREATED)
    // One delivered sale in each store, with no tax snapshot (the report counts those apart, which is what tells how many it read)
    for (const store of [ctx.storeA, ctx.storeA2]) {
      const order = await createOrder(owner, { storeId: store.id, status: OrderStatus.DELIVERED })
      await owner.order.update({ where: { id: order.id }, data: { deliveredAt: new Date() } })
    }
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await guarded.onModuleDestroy()
    await owner.$disconnect()
  })

  const vat = (actor: typeof ctx.adminA, store: { id: string }) =>
    api(app, actor, store)
      .get(ApiRoutes.finance.reports.vat)
      .query({ from: isoDay(-30), to: isoDay(1) })

  it('gives the VAT of the organization with the header of either store: both sales are read', async () => {
    const fromA = await vat(ctx.adminA, ctx.storeA)
    const fromA2 = await vat(ctx.adminA2, ctx.storeA2)

    expect(fromA.status).toBe(OK)
    expect(fromA2.status).toBe(OK)
    expect((fromA.body as VatBody).ordersWithoutTaxSnapshot).toBe(2)
    expect((fromA2.body as VatBody).ordersWithoutTaxSnapshot).toBe(2)
  })

  it('never reads the sales of another organization', async () => {
    const other = await createOrder(owner, {
      storeId: ctx.storeB.id,
      status: OrderStatus.DELIVERED
    })
    await owner.order.update({ where: { id: other.id }, data: { deliveredAt: new Date() } })

    const fromA = await vat(ctx.adminA, ctx.storeA)

    expect((fromA.body as VatBody).ordersWithoutTaxSnapshot).toBe(2)
  })

  // The reports are read in short units, one per page (Step 7.3-D): each opens its own context of the organization, so a read that took its
  // client BEFORE the unit opened (the client is the one of the open context) would read nothing with the switch on. The margin and the
  // aging have no sale or party lines here, so what they prove is that every unit of the read sees the organization: the setup of the books,
  // the role mappings and the account lines.
  it('reads the margin and the aging in units that see the organization, with the header of either store', async () => {
    for (const [actor, store] of [
      [ctx.adminA, ctx.storeA],
      [ctx.adminA2, ctx.storeA2]
    ] as const) {
      const margin = await api(app, actor, store)
        .get(ApiRoutes.finance.reports.margin)
        .query({ from: isoDay(-30), to: isoDay(1) })
      const aging = await api(app, actor, store)
        .get(ApiRoutes.finance.reports.aging)
        .query({ kind: 'payables', asOf: isoDay(1) })
      expect(margin.status).toBe(OK)
      expect(aging.status).toBe(OK)
      expect((margin.body as { warnings: string[] }).warnings).not.toContain('orders_not_readable')
      expect((aging.body as { missingRoles: string[] }).missingRoles).toEqual([])
    }
  })
})
