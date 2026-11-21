import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  AccountRole,
  FinanceCountryCodes,
  FinanceEventKind,
  FinancePostingFailureReason,
  FinancePostingKey,
  FinancePostingOutcome,
  FinanceSourceType,
  InventoryMovementType,
  InventoryReferenceType,
  JournalEntryType,
  OrderReturnStatus
} from '@platform/core/domain'
import { FinanceCloseGuard, FinancePostingService } from '@platform/core/finance-ledger'

import { createOrder } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { withTenantContext } from '../helpers/tenant-context'

const CREATED = 201
const TODAY = new Date().toISOString().slice(0, 10)
const NOON = (day: string): Date => new Date(`${day}T18:00:00Z`)
const BOOKS_START = new Date('2020-01-01T00:00:00Z')

type Line = [code: string, debit: number, credit: number]

// The sale of an order whose total is zero (TDD_18 §4.2 E1/E3, QA HC-138). An exchange gives the customer the credit of the returned
// goods as the discount of the replacement, so the replacement is delivered and paid with nothing to collect: E1 has no money to
// receive and writes nothing, and E3 used to wait for that E1 forever (the sale stuck as source_not_ready, the close of the period
// blocked for the whole organization). Nothing to clear is not an advance that is missing. An order of any other total keeps its rule.
describe('The sale of an order with nothing to collect (an exchange, a full discount)', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let posting: FinancePostingService
  // The guard as the close of a period reaches it: inside the request of a person of the store, whose context is the store and
  // its organization
  let guard: Pick<FinanceCloseGuard, 'check'>
  const codeOf: Record<string, string> = {}

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    posting = app.get(FinancePostingService)
    const realGuard = app.get(FinanceCloseGuard)
    guard = {
      check: (organizationId, options) =>
        // The context of the whole organization, as the worker opens it: the guard is strict and refuses a context of one store
        withTenantContext(
          app.get(PrismaService, { strict: false }),
          { storeIds: [ctx.storeA.id, ctx.storeA2.id], organizationIds: [ctx.orgA.id] },
          () => realGuard.check(organizationId, options)
        )
    }
    const setup = await api(app, ctx.adminA, ctx.storeA)
      .post(ApiRoutes.finance.setup)
      .send({ countryCode: FinanceCountryCodes.EL_SALVADOR, accountingStartDate: '2020-01-01' })
    expect(setup.status).toBe(CREATED)
    const rows = await owner.accountRoleMapping.findMany({
      where: { organizationId: ctx.orgA.id },
      include: { account: { select: { code: true } } }
    })
    for (const row of rows) codeOf[row.role] = row.account.code
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const code = (role: AccountRole): string => codeOf[role] ?? ''
  const post = (orderId: string, kind: FinanceEventKind) =>
    posting.post({
      organizationId: ctx.orgA.id,
      sourceType: FinanceSourceType.ORDER,
      sourceId: orderId,
      kind
    })
  const sorted = (lines: Line[]): Line[] =>
    [...lines].sort((x, y) => x[0].localeCompare(y[0]) || x[1] - y[1] || x[2] - y[2])
  async function linesOfOrder(
    orderId: string,
    key: (id: string) => string
  ): Promise<Line[] | null> {
    const entry = await owner.journalEntry.findUnique({
      where: {
        organizationId_idempotencyKey: { organizationId: ctx.orgA.id, idempotencyKey: key(orderId) }
      },
      include: { lines: { include: { account: { select: { code: true } } } } }
    })
    if (entry === null) return null
    expect(entry.type).toBe(JournalEntryType.SALE)
    return sorted(
      entry.lines.map((line): Line => [line.account.code, line.debitCents, line.creditCents])
    )
  }

  // A delivered and paid order of one line, with the tax and the discount it stored, whose goods left at $4.00 of cost
  async function delivered(input: {
    quantity: number
    unitPriceCents: number
    lineTaxCents: number
    pricesIncludeTax: boolean
    discountCents: number
    taxCents: number
    totalCents: number
    method: string
    paymentStatus?: string
    cost?: number | null
  }): Promise<string> {
    const made = await createOrder(owner, { storeId: ctx.storeA.id })
    await owner.orderItem.update({
      where: { id: made.itemId },
      data: {
        quantity: input.quantity,
        unitPriceCents: input.unitPriceCents,
        taxTreatment: 'taxed',
        taxRateBps: 1300,
        taxCents: input.lineTaxCents
      }
    })
    const subtotalCents = input.quantity * input.unitPriceCents
    await owner.order.update({
      where: { id: made.id },
      data: {
        status: 'DELIVERED',
        subtotalCents,
        shippingCents: 0,
        discountCents: input.discountCents,
        totalCents: input.totalCents,
        taxCents: input.taxCents,
        pricesIncludeTax: input.pricesIncludeTax,
        paymentMethod: input.method,
        paymentStatus: input.paymentStatus ?? 'COMPLETED',
        shippedAt: NOON(TODAY),
        deliveredAt: NOON(TODAY)
      }
    })
    const item = await owner.orderItem.findFirstOrThrow({
      where: { orderId: made.id },
      select: { productId: true }
    })
    await owner.inventoryMovement.create({
      data: {
        storeId: ctx.storeA.id,
        productId: item.productId,
        warehouseId: ctx.warehouseA.id,
        type: InventoryMovementType.ISSUE,
        quantity: input.quantity,
        referenceType: InventoryReferenceType.ORDER,
        referenceId: made.id,
        idempotencyKey: `m-${randomUUID()}`,
        unitCostCents: input.cost === undefined ? 400 : input.cost,
        onHandAfter: 0,
        reservedAfter: 0
      }
    })
    return made.id
  }

  // The events of the order in the order they happen: the goods leaving (E2), then the payment (E1, which posts the sale at once when the
  // order is already delivered and E1 had money to receive)
  async function runEvents(orderId: string): Promise<void> {
    await post(orderId, FinanceEventKind.SENT)
    await post(orderId, FinanceEventKind.PAYMENT)
  }

  const noOpenFailure = async (): Promise<void> => {
    expect(
      await owner.financePostingFailure.count({
        where: { organizationId: ctx.orgA.id, resolvedAt: null }
      })
    ).toBe(0)
    // What the close of a period asks before it closes anything
    expect((await guard.check(ctx.orgA.id, { since: BOOKS_START })).blocked).toBe(false)
  }

  describe('an exchange of the same value', () => {
    it('posts the sale of a replacement priced with the tax included: no revenue and no tax, only the cost of what left', async () => {
      // $11.30 with 13 % in the price, the whole of it given as the discount of the credit: total 0, tax 0
      const id = await delivered({
        quantity: 1,
        unitPriceCents: 1130,
        lineTaxCents: 0,
        pricesIncludeTax: true,
        discountCents: 1130,
        taxCents: 0,
        totalCents: 0,
        method: 'CASH'
      })
      await runEvents(id)
      const sale = await post(id, FinanceEventKind.SALE)
      expect(sale.outcome).toBe(FinancePostingOutcome.POSTED)
      // The cost clears what E2 put in transit, to the cent; nothing to collect, nothing earned
      expect(await linesOfOrder(id, FinancePostingKey.ORDER_SALE)).toEqual(
        sorted([
          [code(AccountRole.COST_OF_GOODS_SOLD), 400, 0],
          [code(AccountRole.INVENTORY_IN_TRANSIT), 0, 400]
        ])
      )
      expect(await post(id, FinanceEventKind.SALE)).toMatchObject({
        outcome: FinancePostingOutcome.REPLAYED
      })
      await noOpenFailure()
    })

    it('posts the sale of a replacement priced without the tax', async () => {
      const id = await delivered({
        quantity: 1,
        unitPriceCents: 1000,
        lineTaxCents: 0,
        pricesIncludeTax: false,
        discountCents: 1000,
        taxCents: 0,
        totalCents: 0,
        method: 'CASH'
      })
      await runEvents(id)
      expect((await post(id, FinanceEventKind.SALE)).outcome).toBe(FinancePostingOutcome.POSTED)
      expect(await linesOfOrder(id, FinancePostingKey.ORDER_SALE)).toEqual(
        sorted([
          [code(AccountRole.COST_OF_GOODS_SOLD), 400, 0],
          [code(AccountRole.INVENTORY_IN_TRANSIT), 0, 400]
        ])
      )
      await noOpenFailure()
    })
  })

  describe('an exchange for less', () => {
    it('posts the sale of a replacement worth less than the credit, which covers it whole', async () => {
      // $5.65 of goods against $11.30 of credit: the discount is capped at the subtotal and the total is zero
      const id = await delivered({
        quantity: 1,
        unitPriceCents: 565,
        lineTaxCents: 0,
        pricesIncludeTax: true,
        discountCents: 565,
        taxCents: 0,
        totalCents: 0,
        method: 'CASH'
      })
      await runEvents(id)
      expect((await post(id, FinanceEventKind.SALE)).outcome).toBe(FinancePostingOutcome.POSTED)
      expect(await linesOfOrder(id, FinancePostingKey.ORDER_SALE)).toEqual(
        sorted([
          [code(AccountRole.COST_OF_GOODS_SOLD), 400, 0],
          [code(AccountRole.INVENTORY_IN_TRANSIT), 0, 400]
        ])
      )
      await noOpenFailure()
    })
  })

  describe('an exchange for more', () => {
    it('keeps the rule of a prepaid order for what the customer pays on top: E1 receives it and E3 clears it', async () => {
      // 2 x $11.30 with the credit of $11.30 as the discount: $11.30 paid, of which $1.30 is tax
      const id = await delivered({
        quantity: 2,
        unitPriceCents: 1130,
        lineTaxCents: 130,
        pricesIncludeTax: true,
        discountCents: 1130,
        taxCents: 130,
        totalCents: 1130,
        method: 'TRANSFER'
      })
      await runEvents(id)
      // E1 had $11.30 to receive and posted the sale by itself
      expect(await linesOfOrder(id, FinancePostingKey.ORDER_SALE)).toEqual(
        sorted([
          [code(AccountRole.CUSTOMER_ADVANCES), 1130, 0],
          [code(AccountRole.SALES_REVENUE), 0, 1000],
          [code(AccountRole.VAT_OUTPUT), 0, 130],
          [code(AccountRole.COST_OF_GOODS_SOLD), 800, 0],
          [code(AccountRole.INVENTORY_IN_TRANSIT), 0, 800]
        ])
      )
      await noOpenFailure()
    })

    it('still refuses the sale of a paid order with a total whose E1 never ran, and posts it once E1 does', async () => {
      const id = await delivered({
        quantity: 1,
        unitPriceCents: 1130,
        lineTaxCents: 130,
        pricesIncludeTax: true,
        discountCents: 0,
        taxCents: 130,
        totalCents: 1130,
        method: 'TRANSFER'
      })
      await post(id, FinanceEventKind.SENT)
      // Paid by the record but E1 never ran: the advance is not there, so the sale is refused (an advance debited from nothing would
      // leave the account negative for good)
      const result = await post(id, FinanceEventKind.SALE)
      expect(result.outcome).toBe(FinancePostingOutcome.FAILED)
      // The payment event posts E1 and the sale with it: the order is settled and leaves nothing pending for the next case
      await post(id, FinanceEventKind.PAYMENT)
      expect(await linesOfOrder(id, FinancePostingKey.ORDER_SALE)).not.toBeNull()
    })
  })

  describe('what the shortcut does not touch', () => {
    it('posts the sale of an order with nothing to collect whether or not it is marked paid, and of a cash on delivery one with no carrier', async () => {
      for (const [method, paymentStatus] of [
        ['TRANSFER', 'PENDING'],
        ['CASH_ON_DELIVERY', 'PENDING']
      ] as const) {
        const id = await delivered({
          quantity: 1,
          unitPriceCents: 1130,
          lineTaxCents: 0,
          pricesIncludeTax: true,
          discountCents: 1130,
          taxCents: 0,
          totalCents: 0,
          method,
          paymentStatus
        })
        await post(id, FinanceEventKind.SENT)
        expect((await post(id, FinanceEventKind.SALE)).outcome).toBe(FinancePostingOutcome.POSTED)
        expect(await linesOfOrder(id, FinancePostingKey.ORDER_SALE)).toEqual(
          sorted([
            [code(AccountRole.COST_OF_GOODS_SOLD), 400, 0],
            [code(AccountRole.INVENTORY_IN_TRANSIT), 0, 400]
          ])
        )
      }
      await noOpenFailure()
    })

    it('keeps the rule of an order with a total: not paid is a sale on credit, cash on delivery needs its carrier', async () => {
      const unpaid = await delivered({
        quantity: 1,
        unitPriceCents: 1130,
        lineTaxCents: 130,
        pricesIncludeTax: true,
        discountCents: 0,
        taxCents: 130,
        totalCents: 1130,
        method: 'TRANSFER',
        paymentStatus: 'PENDING'
      })
      await post(unpaid, FinanceEventKind.SENT)
      expect(await post(unpaid, FinanceEventKind.SALE)).toMatchObject({
        outcome: FinancePostingOutcome.FAILED,
        reason: FinancePostingFailureReason.SOURCE_NOT_READY
      })
      const cod = await delivered({
        quantity: 1,
        unitPriceCents: 1130,
        lineTaxCents: 130,
        pricesIncludeTax: true,
        discountCents: 0,
        taxCents: 130,
        totalCents: 1130,
        method: 'CASH_ON_DELIVERY',
        paymentStatus: 'PENDING'
      })
      await post(cod, FinanceEventKind.SENT)
      expect(await post(cod, FinanceEventKind.SALE)).toMatchObject({
        outcome: FinancePostingOutcome.FAILED,
        reason: FinancePostingFailureReason.CARRIER_MISSING
      })
      // Settle them so that the close guard of the next cases sees nothing pending
      await owner.order.updateMany({
        where: { id: { in: [unpaid, cod] } },
        data: { status: 'CANCELLED' }
      })
      await post(unpaid, FinanceEventKind.SALE)
      await post(cod, FinanceEventKind.SALE)
    })

    it('does not fail the payment of an order with nothing to collect when its method has no account', async () => {
      const id = await delivered({
        quantity: 1,
        unitPriceCents: 1130,
        lineTaxCents: 0,
        pricesIncludeTax: true,
        discountCents: 1130,
        taxCents: 0,
        totalCents: 0,
        method: 'OTHER'
      })
      const rows = await owner.paymentMethodAccount.findMany({
        where: { organizationId: ctx.orgA.id, paymentMethod: 'OTHER' }
      })
      await owner.paymentMethodAccount.deleteMany({
        where: { organizationId: ctx.orgA.id, paymentMethod: 'OTHER' }
      })
      try {
        expect(await post(id, FinanceEventKind.PAYMENT)).toMatchObject({
          outcome: FinancePostingOutcome.NOTHING_TO_POST
        })
      } finally {
        if (rows.length > 0) await owner.paymentMethodAccount.createMany({ data: rows })
      }
      await post(id, FinanceEventKind.SENT)
      expect((await post(id, FinanceEventKind.SALE)).outcome).toBe(FinancePostingOutcome.POSTED)
      await noOpenFailure()
    })

    it('leaves on the books, visible, the advance of an order that was paid and then discounted to nothing (a limit it already had)', async () => {
      // Paid $11.30 (E1 posted), then discounted to nothing before the delivery: the advance E1 credited is the one the sale clears
      const id = await delivered({
        quantity: 1,
        unitPriceCents: 1130,
        lineTaxCents: 130,
        pricesIncludeTax: true,
        discountCents: 0,
        taxCents: 130,
        totalCents: 1130,
        method: 'TRANSFER'
      })
      await owner.order.update({ where: { id }, data: { status: 'SHIPPED', deliveredAt: null } })
      await post(id, FinanceEventKind.SENT)
      expect((await post(id, FinanceEventKind.PAYMENT)).outcome).toBe(FinancePostingOutcome.POSTED)
      await owner.orderItem.updateMany({ where: { orderId: id }, data: { taxCents: 0 } })
      await owner.order.update({
        where: { id },
        data: {
          status: 'DELIVERED',
          deliveredAt: NOON(TODAY),
          discountCents: 1130,
          taxCents: 0,
          totalCents: 0
        }
      })
      expect((await post(id, FinanceEventKind.SALE)).outcome).toBe(FinancePostingOutcome.POSTED)
      // The sale debits its total, which is now zero, so the advance E1 credited is not cleared: it stays on the books for a person to see. An
      // order whose total changes after its payment is a case of its own (plan, debt (d)); this pins today's result
      const lines = await owner.journalLine.findMany({
        where: { entry: { organizationId: ctx.orgA.id, sourceId: id } },
        include: { account: { select: { code: true } } }
      })
      const advances = lines
        .filter(line => line.account.code === code(AccountRole.CUSTOMER_ADVANCES))
        .reduce((sum, line) => sum + line.creditCents - line.debitCents, 0)
      expect(advances).toBe(1130)
    })
  })

  describe('an order with a full discount and no return behind it', () => {
    it('posts its sale the same way', async () => {
      const id = await delivered({
        quantity: 2,
        unitPriceCents: 1130,
        lineTaxCents: 0,
        pricesIncludeTax: true,
        discountCents: 2260,
        taxCents: 0,
        totalCents: 0,
        method: 'CASH'
      })
      await runEvents(id)
      expect((await post(id, FinanceEventKind.SALE)).outcome).toBe(FinancePostingOutcome.POSTED)
      expect(await linesOfOrder(id, FinancePostingKey.ORDER_SALE)).toEqual(
        sorted([
          [code(AccountRole.COST_OF_GOODS_SOLD), 800, 0],
          [code(AccountRole.INVENTORY_IN_TRANSIT), 0, 800]
        ])
      )
      await noOpenFailure()
    })
  })

  // KNOWN RESIDUE, NOT A CORRECT RESULT. The return of an exchange (E8) gives back $10.00 of revenue and $1.30 of tax and credits
  // CUSTOMER_ADVANCES with $11.30 (the credit the customer will use); the replacement above takes the credit as a discount of its
  // price, so its sale has no revenue, no tax and no advance to clear. The books are left with $11.30 of advances nobody consumes and
  // a net output tax of -$1.30 for a product the customer did receive and was never charged for twice. How an exchange must be treated
  // (consume the advance, recognize the revenue and the tax of the replacement) is a decision of the accountant, with the replacement
  // recording how much of the return credit it used: see the plan, "Fix of the sale of an order with nothing to collect (QA 2026-11-16, HC-138)".
  // This case pins today's result so that the day the decision is built it fails and has to be updated on purpose.
  describe('the books after an exchange (known residue, owed to the accountant)', () => {
    // The result the accountant's rule must give is written in the plan (advances 0, output tax 0): when it is built this case changes with it

    it('keeps the credit of the return as an advance that the replacement does not consume', async () => {
      const original = await createOrder(owner, { storeId: ctx.storeA.id })
      await owner.orderItem.update({
        where: { id: original.itemId },
        data: {
          quantity: 1,
          unitPriceCents: 1130,
          taxTreatment: 'taxed',
          taxRateBps: 1300,
          taxCents: 130
        }
      })
      await owner.order.update({
        where: { id: original.id },
        data: {
          status: 'DELIVERED',
          subtotalCents: 1130,
          shippingCents: 0,
          discountCents: 0,
          totalCents: 1130,
          taxCents: 130,
          pricesIncludeTax: true,
          paymentMethod: 'TRANSFER',
          paymentStatus: 'COMPLETED',
          shippedAt: NOON(TODAY),
          deliveredAt: NOON(TODAY)
        }
      })
      await owner.inventoryMovement.create({
        data: {
          storeId: ctx.storeA.id,
          productId: (
            await owner.orderItem.findFirstOrThrow({
              where: { orderId: original.id },
              select: { productId: true }
            })
          ).productId,
          warehouseId: ctx.warehouseA.id,
          type: InventoryMovementType.ISSUE,
          quantity: 1,
          referenceType: InventoryReferenceType.ORDER,
          referenceId: original.id,
          idempotencyKey: `m-${randomUUID()}`,
          unitCostCents: 400,
          onHandAfter: 0,
          reservedAfter: 0
        }
      })
      await runEvents(original.id)
      expect(await linesOfOrder(original.id, FinancePostingKey.ORDER_SALE)).not.toBeNull()

      // The exchange: the return is received (E8) and the replacement has nothing to collect
      const author = await owner.membership.findFirstOrThrow({
        where: { storeId: ctx.storeA.id },
        select: { userId: true }
      })
      const returned = await owner.orderReturn.create({
        data: {
          storeId: ctx.storeA.id,
          orderId: original.id,
          type: 'exchange',
          reason: 'DEFECTIVE',
          status: OrderReturnStatus.RECEIVED,
          shippingPayer: 'sender',
          createdBy: author.userId,
          receivedAt: new Date()
        },
        select: { id: true }
      })
      await owner.orderReturnLine.create({
        data: {
          storeId: ctx.storeA.id,
          returnId: returned.id,
          orderItemId: original.itemId,
          quantity: 1
        }
      })
      await owner.inventoryMovement.create({
        data: {
          storeId: ctx.storeA.id,
          productId: (
            await owner.orderItem.findFirstOrThrow({
              where: { orderId: original.id },
              select: { productId: true }
            })
          ).productId,
          warehouseId: ctx.warehouseA.id,
          type: InventoryMovementType.RETURN_IN,
          quantity: 1,
          referenceType: InventoryReferenceType.RETURN,
          referenceId: returned.id,
          idempotencyKey: `m-${randomUUID()}`,
          unitCostCents: null,
          onHandAfter: 0,
          reservedAfter: 0
        }
      })
      const e8 = await posting.post({
        organizationId: ctx.orgA.id,
        sourceType: FinanceSourceType.RETURN,
        sourceId: returned.id,
        kind: FinanceEventKind.RETURN_RESTOCK
      })
      expect(e8.outcome).toBe(FinancePostingOutcome.POSTED)
      const replacement = await delivered({
        quantity: 1,
        unitPriceCents: 1130,
        lineTaxCents: 0,
        pricesIncludeTax: true,
        discountCents: 1130,
        taxCents: 0,
        totalCents: 0,
        method: 'CASH'
      })
      await runEvents(replacement)
      expect((await post(replacement, FinanceEventKind.SALE)).outcome).toBe(
        FinancePostingOutcome.POSTED
      )

      // What the exchange moved after the original sale (its return and its replacement): $11.30 credited to the advances that nothing
      // consumes, and $1.30 of output tax taken back that the replacement never recognizes again
      const lines = await owner.journalLine.findMany({
        where: {
          entry: { organizationId: ctx.orgA.id, sourceId: { in: [returned.id, replacement] } }
        },
        include: { account: { select: { code: true } } }
      })
      const balance = (role: AccountRole): number =>
        lines
          .filter(line => line.account.code === code(role))
          .reduce((sum, line) => sum + line.creditCents - line.debitCents, 0)
      expect(balance(AccountRole.CUSTOMER_ADVANCES)).toBe(1130)
      expect(balance(AccountRole.VAT_OUTPUT)).toBe(-130)
    })
  })
})
