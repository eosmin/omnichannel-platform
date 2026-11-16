import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'

import { ApiRoutes } from '@platform/core/api'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  AccountRole,
  FinanceCountryCodes,
  FinanceEventKind,
  FinancePostingOutcome,
  FinanceSourceType,
  FiscalDocumentKind,
  FiscalEnvironment,
  FiscalIssueOn,
  InventoryMovementType,
  InventoryReferenceType,
  JournalEntryType,
  OrderReturnStatus,
  OrderStatus
} from '@platform/core/domain'
import { Events } from '@platform/core/events'
import { FinancePostingService } from '@platform/core/finance-ledger'
import { FiscalDocumentsService } from '@platform/fiscal/runtime'
import { SIMULATOR_PROVIDER_ID } from '@platform/fiscal/simulator'

import { createCarrierConnection, createOrder } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const CREATED = 201

const TODAY = new Date().toISOString().slice(0, 10)
const NOON = (day: string): Date => new Date(`${day}T18:00:00Z`)

interface MarginBody {
  totals: { revenueCents: number; costCents: number }
  ledger: {
    revenueCents: number | null
    costCents: number | null
    revenueDifferenceCents: number | null
    costDifferenceCents: number | null
  }
  returns: { revenueCents: number | null; costCents: number | null }
  warnings: string[]
}

const ISSUER = {
  providerId: SIMULATOR_PROVIDER_ID,
  legalName: 'Margin Returns Issuer',
  taxId: 'ISSUER-TAX-ID',
  address: { line1: 'Calle 1', city: 'Ciudad' },
  environment: FiscalEnvironment.SANDBOX,
  issueOn: FiscalIssueOn.DELIVERED,
  credentials: { signingKey: 'not-a-real-signing-key-1234567890' }
}

// What the returns of a range took back, in the margin report (TDD_18 §10; QA scenario ESC-01 step 8 and ESC-02). A return (E8) debits
// the SALES_RETURNS account, not the revenue one, so that is where the report must read it: the figure is what the books gave back of the
// revenue (net of tax) and of the cost, shown apart because the products are gross of returns. Orders here are 2 x $11.30 with 13 % in
// the price (net $20.00, tax $2.60) and $5.65 of shipping, each unit at a cost of $4.00.
describe('The returns in the margin report (HC-137)', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let posting: FinancePostingService
  let documents: FiscalDocumentsService
  let emitter: EventEmitter2

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    posting = app.get(FinancePostingService)
    documents = app.get(FiscalDocumentsService)
    emitter = app.get(EventEmitter2)
    for (const [user, store] of [
      [ctx.adminA, ctx.storeA],
      [ctx.adminB, ctx.storeB]
    ] as const) {
      const setup = await api(app, user, store)
        .post(ApiRoutes.finance.setup)
        .send({ countryCode: FinanceCountryCodes.EL_SALVADOR, accountingStartDate: '2020-01-01' })
      expect(setup.status).toBe(CREATED)
    }
    expect(
      (await api(app, ctx.adminA, ctx.storeA).put(ApiRoutes.fiscal.issuer).send(ISSUER)).status
    ).toBe(OK)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const margin = async (agent = api(app, ctx.adminA, ctx.storeA)): Promise<MarginBody> => {
    const response = await agent.get(
      `${ApiRoutes.finance.reports.margin}?from=${TODAY}&to=${TODAY}`
    )
    expect(response.status).toBe(OK)
    return response.body as MarginBody
  }

  // A delivered order sold and posted (E2 and E3), with its fiscal sale document made by the delivery event
  async function sold(storeId: string, organizationId: string, warehouseId: string) {
    const made = await createOrder(owner, { storeId })
    const connection = await createCarrierConnection(owner, { storeId })
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
        shippedAt: NOON(TODAY),
        deliveredAt: NOON(TODAY),
        carrierConnectionId: connection.id
      }
    })
    const item = await owner.orderItem.findFirstOrThrow({
      where: { orderId: made.id },
      select: { productId: true }
    })
    const movement = (
      type: InventoryMovementType,
      reference: { type: InventoryReferenceType; id: string },
      quantity: number,
      unitCostCents: number | null
    ) =>
      owner.inventoryMovement.create({
        data: {
          storeId,
          productId: item.productId,
          warehouseId,
          type,
          quantity,
          referenceType: reference.type,
          referenceId: reference.id,
          idempotencyKey: `m-${randomUUID()}`,
          unitCostCents,
          onHandAfter: 0,
          reservedAfter: 0
        }
      })
    await movement(
      InventoryMovementType.ISSUE,
      { type: InventoryReferenceType.ORDER, id: made.id },
      2,
      400
    )
    for (const kind of [FinanceEventKind.SENT, FinanceEventKind.SALE]) {
      const posted = await posting.post({
        organizationId,
        sourceType: FinanceSourceType.ORDER,
        sourceId: made.id,
        kind
      })
      expect(posted.outcome).toBe(FinancePostingOutcome.POSTED)
    }
    return { id: made.id, itemId: made.itemId, storeId, movement }
  }

  // A return of `units` units, received and put back on the shelf, with its entry (E8) posted
  async function returned(order: Awaited<ReturnType<typeof sold>>, units: number) {
    const made = await owner.orderReturn.create({
      data: {
        storeId: order.storeId,
        orderId: order.id,
        type: 'refund',
        reason: 'DEFECTIVE',
        status: OrderReturnStatus.RECEIVED,
        shippingPayer: 'sender',
        createdBy: ctx.adminA.id,
        receivedAt: NOON(TODAY)
      },
      select: { id: true }
    })
    await owner.orderReturnLine.create({
      data: {
        storeId: order.storeId,
        returnId: made.id,
        orderItemId: order.itemId,
        quantity: units
      }
    })
    await order.movement(
      InventoryMovementType.RETURN_IN,
      { type: InventoryReferenceType.RETURN, id: made.id },
      units,
      null
    )
    const posted = await posting.post({
      organizationId: ctx.orgA.id,
      sourceType: FinanceSourceType.RETURN,
      sourceId: made.id,
      kind: FinanceEventKind.RETURN_RESTOCK
    })
    expect(posted.outcome).toBe(FinancePostingOutcome.POSTED)
    return made.id
  }

  // What the entries of returns hold on each account, so the report is checked against the books and not against a number typed here
  async function returnEntryAmounts(organizationId: string) {
    const lines = await owner.journalLine.findMany({
      where: { organizationId, entry: { type: JournalEntryType.SALE_RETURN } },
      select: { debitCents: true, creditCents: true, account: { select: { id: true } } }
    })
    const roleOf = new Map(
      (
        await owner.accountRoleMapping.findMany({
          where: {
            organizationId,
            role: { in: [AccountRole.SALES_RETURNS, AccountRole.COST_OF_GOODS_SOLD] }
          },
          select: { role: true, accountId: true }
        })
      ).map(row => [row.accountId, row.role])
    )
    const sum = (role: AccountRole, side: 'debitCents' | 'creditCents'): number =>
      lines
        .filter(line => roleOf.get(line.account.id) === String(role))
        .reduce((total, line) => total + line[side], 0)
    return {
      revenueGivenBack: sum(AccountRole.SALES_RETURNS, 'debitCents'),
      costGivenBack: sum(AccountRole.COST_OF_GOODS_SOLD, 'creditCents')
    }
  }

  it('shows the revenue and the cost a partial return took back, one unit of two', async () => {
    const order = await sold(ctx.storeA.id, ctx.orgA.id, ctx.warehouseA.id)
    const before = await margin()
    await returned(order, 1)
    const after = await margin()

    // One of the two units: $10.00 of revenue (the tax is not revenue) and $4.00 of cost, as the books hold them
    expect(after.returns).toEqual({
      revenueCents: (before.returns.revenueCents ?? 0) + 1000,
      costCents: (before.returns.costCents ?? 0) + 400
    })
    // The sale side does not move with a return: the products are gross of returns and the ledger of the sale entries is the same
    expect(after.totals).toEqual(before.totals)
    expect(after.ledger).toEqual(before.ledger)
    expect(after.ledger.revenueDifferenceCents).toBe(0)
    expect(after.ledger.costDifferenceCents).toBe(0)
    expect(after.warnings).toEqual(before.warnings)
  })

  it('gives back the whole sale when every unit has come back, in two returns, and agrees with the ledger entries of the returns', async () => {
    const base = await margin()
    const order = await sold(ctx.storeA.id, ctx.orgA.id, ctx.warehouseA.id)
    await returned(order, 1)
    await returned(order, 1)
    const body = await margin()

    // The two units, $20.00 of revenue and $8.00 of cost (the shipping fee is not revenue of the products and is not in the figure)
    expect(body.returns.revenueCents).toBe((base.returns.revenueCents ?? 0) + 2000)
    expect(body.returns.costCents).toBe((base.returns.costCents ?? 0) + 800)
    // The report is the ledger: what the returns entries debit on SALES_RETURNS and credit on the cost of goods sold
    const books = await returnEntryAmounts(ctx.orgA.id)
    expect(body.returns).toEqual({
      revenueCents: books.revenueGivenBack,
      costCents: books.costGivenBack
    })
  })

  it('shows what the credit note of the return cancels, less its tax', async () => {
    const order = await sold(ctx.storeA.id, ctx.orgA.id, ctx.warehouseA.id)
    await emitter.emitAsync(Events.ORDER_STATUS_CHANGED, {
      storeId: order.storeId,
      orderId: order.id,
      orderNumber: 'N',
      actor: { type: 'system' as const, id: null },
      from: OrderStatus.SHIPPED,
      to: OrderStatus.DELIVERED,
      notifyCustomer: false
    })
    const sale = await owner.fiscalDocument.findFirstOrThrow({
      where: { orderId: order.id, kind: FiscalDocumentKind.SALE },
      select: { id: true }
    })
    await documents.submit(ctx.orgA.id, sale.id)
    const before = await margin()
    const returnId = await returned(order, 1)
    const noteId = await documents.createCreditNoteForReturn(ctx.orgA.id, returnId)
    expect(noteId).not.toBeNull()
    const note = await owner.fiscalDocument.findUniqueOrThrow({
      where: { id: noteId as string },
      select: { totalCents: true, taxCents: true }
    })
    const after = await margin()

    // The note is $11.30 with $1.30 of tax: the margin shows the $10.00 that is revenue, and the cost of the unit back
    expect(note).toEqual({ totalCents: 1130, taxCents: 130 })
    expect((after.returns.revenueCents ?? 0) - (before.returns.revenueCents ?? 0)).toBe(
      note.totalCents - note.taxCents
    )
    expect((after.returns.costCents ?? 0) - (before.returns.costCents ?? 0)).toBe(400)
  })

  it('counts a return once when the organization maps the returns and the revenue to one account', async () => {
    const order = await sold(ctx.storeA.id, ctx.orgA.id, ctx.warehouseA.id)
    const returnsMapping = await owner.accountRoleMapping.findFirstOrThrow({
      where: { organizationId: ctx.orgA.id, role: AccountRole.SALES_RETURNS }
    })
    const revenueMapping = await owner.accountRoleMapping.findFirstOrThrow({
      where: { organizationId: ctx.orgA.id, role: AccountRole.SALES_REVENUE }
    })
    const before = await margin()
    await owner.accountRoleMapping.update({
      where: {
        organizationId_role: { organizationId: ctx.orgA.id, role: AccountRole.SALES_RETURNS }
      },
      data: { accountId: revenueMapping.accountId }
    })
    try {
      await returned(order, 1)
      const after = await margin()
      // The report reads the accounts the roles map now (like the sale side): the earlier returns were debited on the returns account and
      // are not on the revenue one, so only this return is there. Its debit is on the one account for both roles: $10.00, not $10.00 twice
      expect(after.returns.revenueCents).toBe(1000)
      expect((after.returns.costCents ?? 0) - (before.returns.costCents ?? 0)).toBe(400)
    } finally {
      await owner.accountRoleMapping.update({
        where: {
          organizationId_role: { organizationId: ctx.orgA.id, role: AccountRole.SALES_RETURNS }
        },
        data: { accountId: returnsMapping.accountId }
      })
    }
  })

  it('reads only the returns of the organization of the caller', async () => {
    const other = await sold(ctx.storeB.id, ctx.orgB.id, ctx.warehouseB.id)
    const mine = await margin()
    await owner.orderReturn.create({
      data: {
        storeId: other.storeId,
        orderId: other.id,
        type: 'refund',
        reason: 'DEFECTIVE',
        status: OrderReturnStatus.RECEIVED,
        shippingPayer: 'sender',
        createdBy: ctx.adminB.id,
        receivedAt: NOON(TODAY)
      }
    })
    const created = await owner.orderReturn.findFirstOrThrow({
      where: { orderId: other.id },
      select: { id: true }
    })
    await owner.orderReturnLine.create({
      data: {
        storeId: other.storeId,
        returnId: created.id,
        orderItemId: other.itemId,
        quantity: 1
      }
    })
    await other.movement(
      InventoryMovementType.RETURN_IN,
      { type: InventoryReferenceType.RETURN, id: created.id },
      1,
      null
    )
    const posted = await posting.post({
      organizationId: ctx.orgB.id,
      sourceType: FinanceSourceType.RETURN,
      sourceId: created.id,
      kind: FinanceEventKind.RETURN_RESTOCK
    })
    expect(posted.outcome).toBe(FinancePostingOutcome.POSTED)

    expect((await margin()).returns).toEqual(mine.returns)
    const theirs = (await margin(api(app, ctx.adminB, ctx.storeB))).returns
    expect(theirs).toEqual({ revenueCents: 1000, costCents: 400 })
  })

  // A role the organization has no account for: with no account for the returns no return entry could have posted, so the revenue given
  // back is a true zero; with none for the revenue the report has nothing to read it with and says null (and its warning)
  it.each([
    [AccountRole.SALES_RETURNS, 0, 400],
    [AccountRole.SALES_REVENUE, null, 400]
  ] as const)(
    'answers for the returns when the role %s has no account',
    async (role, revenue, cost) => {
      const mapping = await owner.accountRoleMapping.findFirstOrThrow({
        where: { organizationId: ctx.orgB.id, role }
      })
      await owner.accountRoleMapping.delete({
        where: { organizationId_role: { organizationId: ctx.orgB.id, role } }
      })
      try {
        const body = await margin(api(app, ctx.adminB, ctx.storeB))
        expect(body.returns).toEqual({ revenueCents: revenue, costCents: cost })
      } finally {
        await owner.accountRoleMapping.create({ data: mapping })
      }
    }
  )
})
