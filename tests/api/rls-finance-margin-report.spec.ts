import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { PrismaService, RLS_CONTEXT_ENABLED } from '@platform/core/database'
import { connectionUrls, type OwnerClient } from '@platform/core/database-testing'
import {
  FinanceCountryCodes,
  FinanceEventKind,
  FinancePostingOutcome,
  FinanceSourceType,
  InventoryMovementType,
  InventoryReferenceType,
  OrderStatus
} from '@platform/core/domain'
import { FinancePostingService } from '@platform/core/finance-ledger'

import { createCarrierConnection, createOrder } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const CREATED = 201
const TODAY = new Date().toISOString().slice(0, 10)
const NOON = new Date(`${TODAY}T18:00:00Z`)

interface MarginBody {
  rows: { storeId: string; unitsSold: number }[]
  ordersUsed: number
  ordersNotReadable: number
}

// The margin report is the ORGANIZATION's (TDD_18 §10): it reads the orders and the stock movements of every store of it, whichever store
// the header names. With the switch ON the request of a store holds that store alone, so a report that reads `orders` or
// `inventory_movements` in that context saw one store and changed with the header (the same fault the VAT report had; PR #838 left the
// margin with a text spec only, which proves the mark exists and not that the figure holds). The reads below go through the real app on the
// role of the api, with the switch on and a context required for every query; the books are set up and the sales posted through a plain app.
describe('RLS phase 6: the margin report reads the sales of every store of the organization', () => {
  const prefix = newRunPrefix()
  let setupApp: INestApplication | undefined
  let app: INestApplication | undefined
  let guarded: PrismaService | undefined
  let owner: OwnerClient
  let ctx: TestContext
  let posting: FinancePostingService

  // A delivered order sold and posted (E2 and E3), with the stock it issued
  const sold = async (storeId: string, warehouseId: string): Promise<void> => {
    const made = await createOrder(owner, { storeId })
    const connection = await createCarrierConnection(owner, { storeId })
    // 2 x $11.30 with 13 % in the price, $5.65 of shipping: the figures the margin specs of the books use
    await owner.orderItem.update({
      where: { id: made.itemId },
      data: {
        quantity: 2,
        unitPriceCents: 1130,
        taxTreatment: 'taxed',
        taxRateBps: 1300,
        taxCents: 260
      }
    })
    await owner.order.update({
      where: { id: made.id },
      data: {
        status: OrderStatus.DELIVERED,
        subtotalCents: 2260,
        shippingCents: 565,
        discountCents: 0,
        totalCents: 2825,
        taxCents: 325,
        pricesIncludeTax: true,
        paymentMethod: 'CASH_ON_DELIVERY',
        paymentStatus: 'PENDING',
        shippedAt: NOON,
        deliveredAt: NOON,
        carrierConnectionId: connection.id
      }
    })
    await owner.inventoryMovement.create({
      data: {
        storeId,
        productId: made.productId,
        warehouseId,
        type: InventoryMovementType.ISSUE,
        quantity: 2,
        referenceType: InventoryReferenceType.ORDER,
        referenceId: made.id,
        idempotencyKey: `m-${randomUUID()}`,
        unitCostCents: 400,
        onHandAfter: 0,
        reservedAfter: 0
      }
    })
    for (const kind of [FinanceEventKind.SENT, FinanceEventKind.SALE]) {
      const posted = await posting.post({
        organizationId: ctx.orgA.id,
        sourceType: FinanceSourceType.ORDER,
        sourceId: made.id,
        kind
      })
      expect(posted.outcome).toBe(FinancePostingOutcome.POSTED)
    }
  }

  beforeAll(async () => {
    owner = ownerClient()
    // The books are set up and the sales posted by an app with the switch on but no guard: with row security enforced the role of the api
    // reads and writes only inside a context
    setupApp = await createTestApp([], builder =>
      builder.overrideProvider(RLS_CONTEXT_ENABLED).useValue(true)
    )
    ctx = await seedTestContext(owner, setupApp, prefix)
    const setup = await api(setupApp, ctx.adminA, ctx.storeA)
      .post(ApiRoutes.finance.setup)
      .send({ countryCode: FinanceCountryCodes.EL_SALVADOR, accountingStartDate: '2020-01-01' })
    expect(setup.status).toBe(CREATED)
    posting = setupApp.get(FinancePostingService)
    await sold(ctx.storeA.id, ctx.warehouseA.id)
    await sold(ctx.storeA2.id, ctx.warehouseA.id)

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
  })
  afterAll(async () => {
    // Each step on its own: a failure while the data is made leaves some of these undefined, and one that throws must not leave the
    // others open, which keeps the process alive
    await setupApp?.close()
    await cleanUp(owner, prefix)
    await app?.close()
    await guarded?.onModuleDestroy()
    await owner.$disconnect()
  })

  const margin = async (
    actor: typeof ctx.adminA,
    store: { id: string },
    query: Record<string, string> = {}
  ): Promise<MarginBody> => {
    if (app === undefined) throw new Error('the app of the spec did not start')
    const response = await api(app, actor, store)
      .get(ApiRoutes.finance.reports.margin)
      .query({ from: TODAY, to: TODAY, ...query })
    expect(response.status).toBe(OK)
    return response.body as MarginBody
  }

  it('gives the margin of the organization with the header of either store: both sales are read', async () => {
    const fromA = await margin(ctx.adminA, ctx.storeA)
    const fromA2 = await margin(ctx.adminA2, ctx.storeA2)

    for (const body of [fromA, fromA2]) {
      expect(body.ordersUsed).toBe(2)
      expect(body.ordersNotReadable).toBe(0)
      expect(body.rows.map(row => row.storeId).sort()).toEqual(
        [ctx.storeA.id, ctx.storeA2.id].sort()
      )
      expect(body.rows.every(row => row.unitsSold === 2)).toBe(true)
    }
  })

  it('still narrows to one store when the person asks for it, from the header of the other', async () => {
    const body = await margin(ctx.adminA, ctx.storeA, { storeId: ctx.storeA2.id })

    expect(body.ordersUsed).toBe(1)
    expect(body.rows.map(row => row.storeId)).toEqual([ctx.storeA2.id])
  })
})
