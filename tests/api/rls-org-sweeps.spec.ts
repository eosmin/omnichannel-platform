import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'

import { ApiRoutes } from '@platform/core/api'
import { RoleNames } from '@platform/core/auth'
import { PrismaService, RLS_CONTEXT_ENABLED } from '@platform/core/database'
import { connectionUrls, ensureMembership, type OwnerClient } from '@platform/core/database-testing'
import {
  FinanceCountryCodes,
  FiscalDocumentKind,
  FiscalEnvironment,
  FiscalIssueOn,
  FiscalSweepKind,
  OrderStatus,
  PeriodStatus
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { Events } from '@platform/core/events'
import { SIMULATOR_PROVIDER_ID } from '@platform/fiscal/simulator'

import { createCarrierConnection, createOrder } from '../builders'
import { createTestApp } from '../helpers/app'
import { createActor, seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { type Actor, api } from '../helpers/http'

interface ErrorBody {
  error: { code: string; metadata?: { pendingSources?: number } }
}
interface FindingsBody {
  data: { id: string }[]
}

const OK = 200
const CREATED = 201
const CONFLICT = 409
const SECRET = 'not-a-real-signing-key-1234567890'

// The first day of the month two months ago, in UTC: the books start there, so the first period is over for every zone and nothing
// stands before it
const start = new Date()
start.setUTCDate(1)
start.setUTCMonth(start.getUTCMonth() - 2)
const START = start.toISOString().slice(0, 10)

// Two things the persons of an organization ask that read the rows of EVERY store of it: the close of a month (its guard looks for the
// sales, shipments, returns, movements and remittances of the organization that have no entry, and a month is not closed over one) and
// the reconciliation of the fiscal documents (the sales and returns that have no document). With the switch ON the request of a store
// holds that store alone, so a read of `orders` in it saw the sources of one store: the close passed over a source of a sibling store with
// no entry, and the reconciliation listed the findings of the header's store only. The app is the real one, on the role of the api, with
// the switch on and a context required for every query.
describe('RLS phase 6 (F6-3): the close of a month and the fiscal reconciliation read the whole organization', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let guarded: PrismaService
  let owner: OwnerClient
  let ctx: TestContext
  let emitter: EventEmitter2
  let both: Actor
  let pendingId: string

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
    emitter = app.get(EventEmitter2)
    // Reaches the fiscal documents of A and of A2
    both = await createActor(owner, app, {
      prefix,
      name: `both${prefix.slice(-6)}`,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      roleId: ctx.roleIds[RoleNames.ADMIN]
    })
    await ensureMembership(owner, {
      userId: both.id,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA2.id,
      roleId: ctx.roleIds[RoleNames.ADMIN]
    })
    const setup = await api(app, ctx.adminA, ctx.storeA)
      .post(ApiRoutes.finance.setup)
      .send({ countryCode: FinanceCountryCodes.EL_SALVADOR, accountingStartDate: START })
    expect(setup.status).toBe(CREATED)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await guarded.onModuleDestroy()
    await owner.$disconnect()
  })

  // A delivered order of the store, as the books and the fiscal documents read it: 2 x $11.30 with 13 % in the price
  async function deliveredOrder(storeId: string): Promise<{
    id: string
    storeId: string
    orderNumber: string
  }> {
    const made = await createOrder(owner, { storeId })
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
    const connection = await createCarrierConnection(owner, { storeId })
    return owner.order.update({
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
        carrierConnectionId: connection.id,
        shippedAt: new Date(),
        deliveredAt: new Date()
      },
      select: { id: true, storeId: true, orderNumber: true }
    })
  }

  const closeOf = (actor: Actor, store: { id: string }, periodId: string) =>
    api(app, actor, store).post(ApiRoutes.finance.periods.close(periodId)).send({})

  describe('the close of a month', () => {
    it('is refused for a source with no entry in a sibling store, with the header of either store', async () => {
      const pending = await deliveredOrder(ctx.storeA2.id)
      pendingId = pending.id
      const period = await owner.fiscalPeriod.findFirstOrThrow({
        where: { organizationId: ctx.orgA.id },
        orderBy: [{ year: 'asc' }, { month: 'asc' }]
      })

      const fromA = await closeOf(ctx.adminA, ctx.storeA, period.id)
      const fromA2 = await closeOf(ctx.adminA2, ctx.storeA2, period.id)

      for (const answer of [fromA, fromA2]) {
        expect(answer.status).toBe(CONFLICT)
        const body = answer.body as ErrorBody
        expect(body.error.code).toBe(ErrorCodes.FINANCE_CLOSE_PENDING_POSTINGS)
        expect(body.error.metadata?.pendingSources).toBeGreaterThanOrEqual(1)
      }
      expect(
        (await owner.fiscalPeriod.findUniqueOrThrow({ where: { id: period.id } })).status
      ).toBe(PeriodStatus.OPEN)
    })

    it('closes once the source is not one any more, with a header that is not the store of the source', async () => {
      await owner.order.update({
        where: { id: pendingId },
        data: { status: OrderStatus.CANCELLED }
      })
      const period = await owner.fiscalPeriod.findFirstOrThrow({
        where: { organizationId: ctx.orgA.id },
        orderBy: [{ year: 'asc' }, { month: 'asc' }]
      })

      const closed = await closeOf(ctx.adminA, ctx.storeA, period.id)

      expect(closed.status).toBe(OK)
      expect(
        (await owner.fiscalPeriod.findUniqueOrThrow({ where: { id: period.id } })).status
      ).toBe(PeriodStatus.CLOSED)
    })
  })

  describe('the reconciliation of the fiscal documents', () => {
    let lostInA: string
    let lostInA2: string

    beforeAll(async () => {
      const issuer = await api(app, ctx.adminA, ctx.storeA)
        .put(ApiRoutes.fiscal.issuer)
        .send({
          providerId: SIMULATOR_PROVIDER_ID,
          legalName: 'Sweeps Issuer',
          taxId: 'ISSUER-TAX-ID',
          address: { line1: 'Calle 1', city: 'Ciudad' },
          environment: FiscalEnvironment.SANDBOX,
          issueOn: FiscalIssueOn.DELIVERED,
          credentials: { signingKey: SECRET }
        })
      expect(issuer.status).toBe(OK)
      // The first document is the go-live of the issuer: a sale of A is documented by the event
      const first = await deliveredOrder(ctx.storeA.id)
      await emitter.emitAsync(Events.ORDER_STATUS_CHANGED, {
        storeId: first.storeId,
        orderId: first.id,
        orderNumber: first.orderNumber,
        actor: { type: 'system', id: null },
        from: OrderStatus.SHIPPED,
        to: OrderStatus.DELIVERED,
        notifyCustomer: false
      })
      await owner.fiscalDocument.findFirstOrThrow({
        where: { orderId: first.id, kind: FiscalDocumentKind.SALE },
        select: { id: true }
      })
      // Two sales recognized after it that no document was made for, one in each store
      lostInA = (await deliveredOrder(ctx.storeA.id)).id
      lostInA2 = (await deliveredOrder(ctx.storeA2.id)).id
    })

    const found = async (actor: Actor, store: { id: string }): Promise<string[]> => {
      const answer = await api(app, actor, store)
        .get(ApiRoutes.fiscal.reconciliation)
        .query({ kind: FiscalSweepKind.SALE_WITHOUT_DOCUMENT })
      expect(answer.status).toBe(OK)
      return (answer.body as FindingsBody).data.map(finding => finding.id)
    }

    it('lists the sales of both stores to a person who reaches both, with the header of either', async () => {
      const fromA = await found(both, ctx.storeA)
      const fromA2 = await found(both, ctx.storeA2)

      for (const ids of [fromA, fromA2]) {
        expect(ids).toEqual(expect.arrayContaining([lostInA, lostInA2]))
      }
    })

    it('lists only the stores a person reaches, whatever the header says', async () => {
      const fromA = await found(ctx.adminA, ctx.storeA)
      const fromA2 = await found(ctx.adminA2, ctx.storeA2)

      expect(fromA).toContain(lostInA)
      expect(fromA).not.toContain(lostInA2)
      expect(fromA2).toContain(lostInA2)
      expect(fromA2).not.toContain(lostInA)
    })
  })
})
