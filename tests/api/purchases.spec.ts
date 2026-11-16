import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  AccountType,
  FinanceCountryCodes,
  JournalEntryType,
  NormalSide,
  PartyType,
  PurchaseConflicts,
  PurchaseOrderStatus
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'

import { createProduct } from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

interface ErrorBody {
  error: { code: string; metadata?: Record<string, unknown> }
}
interface LineBody {
  id: string
  storeId: string
  quantity: number
  receivedQuantity: number
  unitCostCents: number
}
interface ReceiptBody {
  id: string
  subtotalCents: number
  taxCents: number
  totalCents: number
  dueOn: string
  taxCreditable: boolean
  entryId: string
  lines: { quantity: number; movementId: string }[]
}
interface OrderBody {
  id: string
  number: string
  status: string
  lines: LineBody[]
  receipts: ReceiptBody[]
}
interface PaymentBody {
  id: string
  amountCents: number
  voidedByEntryId: string | null
  entryId: string
}
interface BalanceBody {
  billedCents: number
  paidCents: number
  openCents: number
  overdueCents: number
}
interface PayablesBody {
  bills: { receiptId: string; openCents: number; dueOn: string; overdue: boolean }[]
  suppliers: BalanceBody[]
}

const OK = 200
const CREATED = 201
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409

const CASH = '1101'
const BANK = '111001'
const INVENTORY = '1301'
const VAT_CREDIT = '1401'
const PAYABLE = '2101'
const UNCATEGORIZED = '6112'

const DAY_MS = 86_400_000
const isoDay = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10)
const TODAY = isoDay(0)

describe('Suppliers, purchase orders, receipts and supplier payments (Step 4B.5)', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let accounts: Record<string, string> = {}
  let vatId = ''

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    for (const actor of [asAdminA(), asAdminB()]) {
      const setup = await actor
        .post(ApiRoutes.finance.setup)
        .send({ countryCode: FinanceCountryCodes.EL_SALVADOR, accountingStartDate: '2020-01-01' })
      expect(setup.status).toBe(CREATED)
    }
    const rows = await owner.ledgerAccount.findMany({
      where: { organizationId: ctx.orgA.id },
      select: { id: true, code: true }
    })
    accounts = Object.fromEntries(rows.map(row => [row.code, row.id]))
    vatId = (
      await owner.taxRate.findFirstOrThrow({ where: { organizationId: ctx.orgA.id, code: 'IVA' } })
    ).id
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const asAdminA = () => api(app, ctx.adminA, ctx.storeA)
  const asAdminB = () => api(app, ctx.adminB, ctx.storeB)
  const errorOf = (response: { body: unknown }) => (response.body as ErrorBody).error
  const key = (): string => `k${randomUUID().replaceAll('-', '')}`
  const asRole = async (
    name: string,
    permissions: readonly (typeof Permissions)[keyof typeof Permissions][]
  ) =>
    api(
      app,
      await actorWithPermissions(owner, app, {
        prefix,
        name,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions
      }),
      ctx.storeA
    )

  async function supplier(extra: Record<string, unknown> = {}): Promise<{ id: string }> {
    const response = await asAdminA()
      .post(ApiRoutes.suppliers.create)
      .send({ name: `Supplier ${randomUUID().slice(0, 8)}`, paymentTermsDays: 30, ...extra })
    expect(response.status).toBe(CREATED)
    return response.body as { id: string }
  }
  async function product(): Promise<{ id: string }> {
    return createProduct(owner, { storeId: ctx.storeA.id })
  }
  // An order of two lines placed with the supplier: 10 x $5.00 taxed at 13 % and 4 x $2.50 untaxed
  async function placedOrder(
    supplierId: string,
    extra: { lines?: Record<string, unknown>[] } = {}
  ): Promise<OrderBody> {
    const [first, second] = [await product(), await product()]
    const created = await asAdminA()
      .post(ApiRoutes.purchaseOrders.create)
      .send({
        idempotencyKey: key(),
        supplierId,
        warehouseId: ctx.warehouseA.id,
        lines: extra.lines ?? [
          { productId: first.id, quantity: 10, unitCostCents: 500, taxRateId: vatId },
          { productId: second.id, quantity: 4, unitCostCents: 250 }
        ]
      })
    expect(created.status).toBe(CREATED)
    const placed = await asAdminA().post(
      ApiRoutes.purchaseOrders.order((created.body as OrderBody).id)
    )
    expect(placed.status).toBe(CREATED)
    return placed.body as OrderBody
  }
  const receive = (orderId: string, body: Record<string, unknown>, who = asAdminA()) =>
    who
      .post(ApiRoutes.purchaseOrders.receive(orderId))
      .send({ idempotencyKey: key(), receivedOn: TODAY, ...body })
  const pay = (supplierId: string, body: Record<string, unknown>, who = asAdminA()) =>
    who
      .post(ApiRoutes.suppliers.recordPayment(supplierId))
      .send({ idempotencyKey: key(), paidFromAccountId: accounts[BANK], paidOn: TODAY, ...body })
  async function linesOf(entryId: string): Promise<[string, number, number][]> {
    const lines = await owner.journalLine.findMany({
      where: { entryId },
      orderBy: { lineNo: 'asc' },
      include: { account: { select: { code: true } } }
    })
    // By account code: the order of the lines of an entry is not the contract, the accounts and amounts are
    return lines
      .map((line): [string, number, number] => [
        line.account.code,
        line.debitCents,
        line.creditCents
      ])
      .sort((x, y) => x[0].localeCompare(y[0]))
  }

  describe('suppliers', () => {
    it('creates, reads, renames and switches one off, and refuses a name taken ignoring case', async () => {
      const created = await supplier({ name: 'Distribuidora Uno', taxId: '0614-010101-101-1' })
      const taken = await asAdminA()
        .post(ApiRoutes.suppliers.create)
        .send({ name: 'DISTRIBUIDORA UNO' })
      expect(taken.status).toBe(CONFLICT)
      expect(errorOf(taken).metadata).toMatchObject({
        conflict: PurchaseConflicts.SUPPLIER_NAME_IN_USE
      })

      const renamed = await asAdminA()
        .patch(ApiRoutes.suppliers.update(created.id))
        .send({ name: 'Distribuidora Dos', paymentTermsDays: 15, active: false })
      expect(renamed.status).toBe(OK)
      expect(renamed.body).toMatchObject({
        name: 'Distribuidora Dos',
        paymentTermsDays: 15,
        active: false
      })

      const listed = await asAdminA().get(ApiRoutes.suppliers.list)
      expect((listed.body as { data: { id: string }[] }).data.map(row => row.id)).not.toContain(
        created.id
      )
      const all = await asAdminA().get(`${ApiRoutes.suppliers.list}?includeInactive=true`)
      expect((all.body as { data: { id: string }[] }).data.map(row => row.id)).toContain(created.id)
      await waitForAuditEntries(owner, {
        action: AuditAction.SUPPLIER_CREATED,
        resourceId: created.id
      })
    })

    it('refuses a payable account that is not a liability', async () => {
      const response = await asAdminA()
        .post(ApiRoutes.suppliers.create)
        .send({ name: `S ${key()}`, defaultPayableAccountId: accounts[CASH] })
      expect(response.status).toBe(BAD_REQUEST)
    })

    it('does not see a supplier of another organization', async () => {
      const mine = await supplier()
      expect((await asAdminB().get(ApiRoutes.suppliers.byId(mine.id))).status).toBe(NOT_FOUND)
      expect(
        (await asAdminB().patch(ApiRoutes.suppliers.update(mine.id)).send({ name: 'Taken over' }))
          .status
      ).toBe(NOT_FOUND)
    })

    it('asks for the purchases permission to manage them and the money permission to pay', async () => {
      const viewer = await asRole('purchases-viewer', [Permissions.FINANCE_VIEW])
      expect((await viewer.get(ApiRoutes.suppliers.list)).status).toBe(FORBIDDEN)
      const buyer = await asRole('purchases-buyer', [Permissions.FINANCE_MANAGE_PURCHASES])
      expect((await buyer.get(ApiRoutes.suppliers.list)).status).toBe(OK)
      const mine = await supplier()
      const refused = await pay(mine.id, { amountCents: 100 }, buyer)
      expect(refused.status).toBe(FORBIDDEN)
    })
  })

  describe('a purchase order', () => {
    it('is numbered by the organization, edited while a draft and placed once', async () => {
      const seller = await supplier()
      const item = await product()
      const created = await asAdminA()
        .post(ApiRoutes.purchaseOrders.create)
        .send({
          idempotencyKey: key(),
          supplierId: seller.id,
          warehouseId: ctx.warehouseA.id,
          lines: [{ productId: item.id, quantity: 3, unitCostCents: 1000 }]
        })
      expect(created.status).toBe(CREATED)
      const draft = created.body as OrderBody
      expect(draft).toMatchObject({ status: PurchaseOrderStatus.DRAFT })
      expect(draft.number).toMatch(/^PO-\d{6}$/)

      const edited = await asAdminA()
        .patch(ApiRoutes.purchaseOrders.update(draft.id))
        .send({ lines: [{ productId: item.id, quantity: 5, unitCostCents: 900 }] })
      expect(edited.status).toBe(OK)
      expect((edited.body as OrderBody).lines).toMatchObject([{ quantity: 5, unitCostCents: 900 }])

      const placed = await asAdminA().post(ApiRoutes.purchaseOrders.order(draft.id))
      expect(placed.body).toMatchObject({ status: PurchaseOrderStatus.ORDERED })
      const again = await asAdminA().post(ApiRoutes.purchaseOrders.order(draft.id))
      expect(again.status).toBe(CONFLICT)
      expect(errorOf(again).code).toBe(ErrorCodes.PURCHASE_ORDER_INVALID_STATUS_TRANSITION)
      const late = await asAdminA()
        .patch(ApiRoutes.purchaseOrders.update(draft.id))
        .send({ notes: 'late' })
      expect(late.status).toBe(CONFLICT)
      expect(errorOf(late).metadata).toMatchObject({ conflict: PurchaseConflicts.ORDER_NOT_DRAFT })
    })

    it('answers a retry of the create with the first order and refuses the same key with another body', async () => {
      const seller = await supplier()
      const item = await product()
      const body = {
        idempotencyKey: key(),
        supplierId: seller.id,
        warehouseId: ctx.warehouseA.id,
        lines: [{ productId: item.id, quantity: 1, unitCostCents: 100 }]
      }
      const first = await asAdminA().post(ApiRoutes.purchaseOrders.create).send(body)
      const retry = await asAdminA().post(ApiRoutes.purchaseOrders.create).send(body)
      expect(retry.status).toBe(CREATED)
      expect((retry.body as OrderBody).id).toBe((first.body as OrderBody).id)
      const other = await asAdminA()
        .post(ApiRoutes.purchaseOrders.create)
        .send({ ...body, lines: [{ productId: item.id, quantity: 2, unitCostCents: 100 }] })
      expect(other.status).toBe(CONFLICT)
      expect(errorOf(other).metadata).toMatchObject({ conflict: PurchaseConflicts.KEY_REUSED })
    })

    it('refuses an order with no lines to place, and a supplier or warehouse of another organization', async () => {
      const seller = await supplier()
      const empty = await asAdminA()
        .post(ApiRoutes.purchaseOrders.create)
        .send({ idempotencyKey: key(), supplierId: seller.id, warehouseId: ctx.warehouseA.id })
      expect(empty.status).toBe(CREATED)
      const placed = await asAdminA().post(
        ApiRoutes.purchaseOrders.order((empty.body as OrderBody).id)
      )
      expect(placed.status).toBe(CONFLICT)
      expect(errorOf(placed).metadata).toMatchObject({
        conflict: PurchaseConflicts.ORDER_NEEDS_LINES
      })
      const foreign = await asAdminA()
        .post(ApiRoutes.purchaseOrders.create)
        .send({ idempotencyKey: key(), supplierId: seller.id, warehouseId: ctx.warehouseB.id })
      expect(foreign.status).toBe(NOT_FOUND)
    })

    it('cancels a draft or a placed order that has no receipt, and closes nothing that has not arrived', async () => {
      const seller = await supplier()
      const order = await placedOrder(seller.id)
      expect(
        (await asAdminA().post(ApiRoutes.purchaseOrders.close(order.id)).send({})).status
      ).toBe(CONFLICT)
      const cancelled = await asAdminA()
        .post(ApiRoutes.purchaseOrders.cancel(order.id))
        .send({ reason: 'No longer needed' })
      expect(cancelled.body).toMatchObject({ status: PurchaseOrderStatus.CANCELLED })
      expect(
        (await receive(order.id, { lines: [{ orderLineId: order.lines[0]?.id, quantity: 1 }] }))
          .status
      ).toBe(CONFLICT)
    })
  })

  describe('receiving (E10)', () => {
    it('raises the stock at the cost before tax, posts one balanced entry and records what is owed', async () => {
      const seller = await supplier({ paymentTermsDays: 30 })
      const order = await placedOrder(seller.id)
      const [taxed, untaxed] = order.lines
      const received = await receive(order.id, {
        supplierDocumentNumber: 'CCF-77',
        lines: [
          { orderLineId: taxed?.id, quantity: 10 },
          { orderLineId: untaxed?.id, quantity: 4 }
        ]
      })
      expect(received.status).toBe(CREATED)
      const body = received.body as OrderBody
      expect(body.status).toBe(PurchaseOrderStatus.RECEIVED)
      const [receipt] = body.receipts
      // 10 x 500 = 5000 (+ 13 % = 650) and 4 x 250 = 1000: 6000 + 650
      expect(receipt).toMatchObject({
        subtotalCents: 6000,
        taxCents: 650,
        totalCents: 6650,
        taxCreditable: true
      })
      expect(receipt?.dueOn).toBe(isoDay(30))
      expect(await linesOf(receipt?.entryId ?? '')).toEqual([
        [INVENTORY, 6000, 0],
        [VAT_CREDIT, 650, 0],
        [PAYABLE, 0, 6650]
      ])
      // Every line names the movement of stock it made
      expect(
        await owner.inventoryMovement.count({
          where: { id: { in: (receipt?.lines ?? []).map(line => line.movementId) } }
        })
      ).toBe(2)
      const entry = await owner.journalEntry.findUniqueOrThrow({
        where: { id: receipt?.entryId ?? '' }
      })
      expect(entry.type).toBe(JournalEntryType.PURCHASE_RECEIPT)

      // The stock and its value are the ones of the ledger
      const taxedLine = await owner.purchaseOrderLine.findUniqueOrThrow({
        where: { id: taxed?.id ?? '' }
      })
      const taxedLevel = await owner.inventoryLevel.findFirstOrThrow({
        where: {
          storeId: ctx.storeA.id,
          warehouseId: ctx.warehouseA.id,
          productId: taxedLine.productId
        }
      })
      expect(taxedLevel.onHand).toBe(10)
      expect(Number(taxedLevel.valueCents)).toBe(5000)
      await waitForAuditEntries(owner, {
        action: AuditAction.PURCHASE_ORDER_RECEIVED,
        resourceId: receipt?.id
      })
    })

    it('moves the weighted average with each receipt', async () => {
      const seller = await supplier()
      const item = await product()
      const order = await placedOrder(seller.id, {
        lines: [{ productId: item.id, quantity: 4, unitCostCents: 1000 }]
      })
      const line = order.lines[0]
      await receive(order.id, { lines: [{ orderLineId: line?.id, quantity: 2 }] })
      const second = await receive(order.id, { lines: [{ orderLineId: line?.id, quantity: 2 }] })
      expect(second.status).toBe(CREATED)
      const level = await owner.inventoryLevel.findFirstOrThrow({
        where: { storeId: ctx.storeA.id, productId: item.id, warehouseId: ctx.warehouseA.id }
      })
      expect(level.onHand).toBe(4)
      expect(Number(level.valueCents)).toBe(4000)
    })

    it('takes a partial receipt, refuses more than was ordered and closes a purchase that arrived short', async () => {
      const seller = await supplier()
      const order = await placedOrder(seller.id)
      const [taxed] = order.lines
      const partial = await receive(order.id, { lines: [{ orderLineId: taxed?.id, quantity: 6 }] })
      expect((partial.body as OrderBody).status).toBe(PurchaseOrderStatus.PARTIALLY_RECEIVED)
      const over = await receive(order.id, { lines: [{ orderLineId: taxed?.id, quantity: 5 }] })
      expect(over.status).toBe(CONFLICT)
      expect(errorOf(over).code).toBe(ErrorCodes.PURCHASE_RECEIPT_EXCEEDS_ORDER)
      const cancel = await asAdminA().post(ApiRoutes.purchaseOrders.cancel(order.id)).send({})
      expect(cancel.status).toBe(CONFLICT)
      const closed = await asAdminA()
        .post(ApiRoutes.purchaseOrders.close(order.id))
        .send({ reason: 'Supplier short' })
      expect(closed.body).toMatchObject({ status: PurchaseOrderStatus.CLOSED })
      expect(
        (await receive(order.id, { lines: [{ orderLineId: taxed?.id, quantity: 1 }] })).status
      ).toBe(CONFLICT)
    })

    it('is one receipt for a retry, and a mistake for the same key with another body', async () => {
      const seller = await supplier()
      const order = await placedOrder(seller.id)
      const [taxed] = order.lines
      const body = {
        idempotencyKey: key(),
        receivedOn: TODAY,
        lines: [{ orderLineId: taxed?.id, quantity: 2 }]
      }
      const first = await asAdminA().post(ApiRoutes.purchaseOrders.receive(order.id)).send(body)
      const retry = await asAdminA().post(ApiRoutes.purchaseOrders.receive(order.id)).send(body)
      expect(retry.status).toBe(CREATED)
      expect((retry.body as OrderBody).receipts).toHaveLength(1)
      expect((first.body as OrderBody).receipts[0]?.id).toBe(
        (retry.body as OrderBody).receipts[0]?.id
      )
      const level = await owner.inventoryLevel.findFirstOrThrow({
        where: {
          storeId: ctx.storeA.id,
          productId: (
            await owner.purchaseOrderLine.findUniqueOrThrow({ where: { id: taxed?.id ?? '' } })
          ).productId
        }
      })
      expect(level.onHand).toBe(2)
      const other = await asAdminA()
        .post(ApiRoutes.purchaseOrders.receive(order.id))
        .send({ ...body, lines: [{ orderLineId: taxed?.id, quantity: 3 }] })
      expect(other.status).toBe(CONFLICT)
      expect(errorOf(other).metadata).toMatchObject({ conflict: PurchaseConflicts.KEY_REUSED })
    })

    it('books a tax with no supplier document to the expense account, never to input VAT', async () => {
      const seller = await supplier()
      const order = await placedOrder(seller.id)
      const [taxed] = order.lines
      const received = await receive(order.id, {
        lines: [{ orderLineId: taxed?.id, quantity: 10 }]
      })
      const [receipt] = (received.body as OrderBody).receipts
      expect(receipt).toMatchObject({ taxCreditable: false, totalCents: 5650 })
      expect(await linesOf(receipt?.entryId ?? '')).toEqual([
        [INVENTORY, 5000, 0],
        [PAYABLE, 0, 5650],
        [UNCATEGORIZED, 650, 0]
      ])
      // The order is received whole: a creditable tax needs a document, on a fresh order
      const next = await placedOrder(seller.id)
      const creditable = await receive(next.id, {
        taxCreditable: true,
        lines: [{ orderLineId: next.lines[0]?.id, quantity: 1 }]
      })
      expect(creditable.status).toBe(BAD_REQUEST)
    })

    it('refuses the invoice of one order on another order of the supplier', async () => {
      const seller = await supplier()
      const first = await placedOrder(seller.id)
      const second = await placedOrder(seller.id)
      const document = `D-${key()}`
      const ok = await receive(first.id, {
        supplierDocumentNumber: document,
        lines: [{ orderLineId: first.lines[0]?.id, quantity: 1 }]
      })
      expect(ok.status).toBe(CREATED)
      // The same order may take the rest of its invoice in another receipt
      const again = await receive(first.id, {
        supplierDocumentNumber: document,
        lines: [{ orderLineId: first.lines[0]?.id, quantity: 1 }]
      })
      expect(again.status).toBe(CREATED)
      const elsewhere = await receive(second.id, {
        supplierDocumentNumber: document,
        lines: [{ orderLineId: second.lines[0]?.id, quantity: 1 }]
      })
      expect(elsewhere.status).toBe(CONFLICT)
      expect(errorOf(elsewhere).metadata).toMatchObject({
        conflict: PurchaseConflicts.DOCUMENT_NUMBER_IN_USE
      })
    })

    it('does not post anything when the stock refuses the receipt', async () => {
      const seller = await supplier()
      const item = await product()
      const order = await placedOrder(seller.id, {
        lines: [{ productId: item.id, quantity: 2, unitCostCents: 100 }]
      })
      await owner.product.update({ where: { id: item.id }, data: { trackInventory: false } })
      const before = await owner.journalEntry.count({ where: { organizationId: ctx.orgA.id } })
      const refused = await receive(order.id, {
        lines: [{ orderLineId: order.lines[0]?.id, quantity: 2 }]
      })
      expect(refused.status).toBeGreaterThanOrEqual(BAD_REQUEST)
      expect(await owner.journalEntry.count({ where: { organizationId: ctx.orgA.id } })).toBe(
        before
      )
      expect(await owner.purchaseReceipt.count({ where: { purchaseOrderId: order.id } })).toBe(0)
    })

    it('does not let another organization receive or read the order', async () => {
      const seller = await supplier()
      const order = await placedOrder(seller.id)
      expect((await asAdminB().get(ApiRoutes.purchaseOrders.byId(order.id))).status).toBe(NOT_FOUND)
      const stolen = await receive(
        order.id,
        { lines: [{ orderLineId: order.lines[0]?.id, quantity: 1 }] },
        asAdminB()
      )
      expect(stolen.status).toBe(NOT_FOUND)
    })

    it('shows the lines of the stores the caller belongs to, and only those', async () => {
      const seller = await supplier()
      const order = await placedOrder(seller.id)
      const buyerOfOtherStore = api(
        app,
        await actorWithPermissions(owner, app, {
          prefix,
          name: 'buyer-store-a2',
          organizationId: ctx.orgA.id,
          storeId: ctx.storeA2.id,
          permissions: [Permissions.FINANCE_MANAGE_PURCHASES]
        }),
        ctx.storeA2
      )
      const read = await buyerOfOtherStore.get(ApiRoutes.purchaseOrders.byId(order.id))
      expect(read.status).toBe(OK)
      expect((read.body as OrderBody).lines).toEqual([])
      const refused = await receive(
        order.id,
        { lines: [{ orderLineId: order.lines[0]?.id, quantity: 1 }] },
        buyerOfOtherStore
      )
      expect(refused.status).toBe(CONFLICT)
      expect(errorOf(refused).metadata).toMatchObject({
        conflict: PurchaseConflicts.LINE_STORE_NOT_VISIBLE
      })
    })
  })

  describe('paying a supplier (E11)', () => {
    async function billed(termsDays = 30): Promise<{ supplierId: string; receipt: ReceiptBody }> {
      const seller = await supplier({ paymentTermsDays: termsDays })
      const order = await placedOrder(seller.id, {
        lines: [{ productId: (await product()).id, quantity: 10, unitCostCents: 1000 }]
      })
      const received = await receive(order.id, {
        supplierDocumentNumber: `D-${key()}`,
        lines: [{ orderLineId: order.lines[0]?.id, quantity: 10 }]
      })
      const receipt = (received.body as OrderBody).receipts[0]
      if (receipt === undefined) throw new Error('no receipt')
      return { supplierId: seller.id, receipt }
    }

    it('shows what is owed with its due day, and the payables of the organization', async () => {
      const { supplierId, receipt } = await billed(0)
      const balance = await asAdminA().get(ApiRoutes.suppliers.balance(supplierId))
      expect(balance.body).toMatchObject({ billedCents: 10_000, paidCents: 0, openCents: 10_000 })
      const payables = await asAdminA().get(
        `${ApiRoutes.suppliers.payables}?supplierId=${supplierId}`
      )
      expect((payables.body as PayablesBody).bills).toMatchObject([
        { receiptId: receipt.id, openCents: 10_000, dueOn: TODAY, overdue: false }
      ])
    })

    it('pays in parts from the account chosen, posts Dr payable Cr account, and never above what is open', async () => {
      const { supplierId, receipt } = await billed()
      const first = await pay(supplierId, {
        amountCents: 4000,
        purchaseReceiptId: receipt.id,
        paidFromAccountId: accounts[CASH]
      })
      expect(first.status).toBe(CREATED)
      expect(await linesOf((first.body as PaymentBody).entryId)).toEqual([
        [CASH, 0, 4000],
        [PAYABLE, 4000, 0]
      ])
      const over = await pay(supplierId, { amountCents: 6001, purchaseReceiptId: receipt.id })
      expect(over.status).toBe(CONFLICT)
      expect(errorOf(over).metadata).toMatchObject({
        conflict: PurchaseConflicts.PAYMENT_EXCEEDS_RECEIPT,
        openCents: 6000
      })
      const rest = await pay(supplierId, { amountCents: 6000, purchaseReceiptId: receipt.id })
      expect(rest.status).toBe(CREATED)
      expect((await asAdminA().get(ApiRoutes.suppliers.balance(supplierId))).body).toMatchObject({
        openCents: 0,
        paidCents: 10_000
      })
      const nothing = await pay(supplierId, { amountCents: 1 })
      expect(nothing.status).toBe(CONFLICT)
      expect(errorOf(nothing).metadata).toMatchObject({
        conflict: PurchaseConflicts.PAYMENT_EXCEEDS_BALANCE
      })
    })

    it('applies a payment that names no bill to the supplier in all', async () => {
      const { supplierId, receipt } = await billed()
      expect((await pay(supplierId, { amountCents: 2500 })).status).toBe(CREATED)
      const payables = await asAdminA().get(
        `${ApiRoutes.suppliers.payables}?supplierId=${supplierId}`
      )
      expect((payables.body as PayablesBody).bills).toMatchObject([
        { receiptId: receipt.id, openCents: 7500 }
      ])
      expect((payables.body as PayablesBody).suppliers).toMatchObject([{ openCents: 7500 }])
    })

    it('is one payment for a retry, and refuses an account that is not cash and a payment of another supplier', async () => {
      const { supplierId, receipt } = await billed()
      const body = {
        idempotencyKey: key(),
        paidFromAccountId: accounts[BANK],
        paidOn: TODAY,
        amountCents: 1000
      }
      const first = await asAdminA().post(ApiRoutes.suppliers.recordPayment(supplierId)).send(body)
      const retry = await asAdminA().post(ApiRoutes.suppliers.recordPayment(supplierId)).send(body)
      expect((retry.body as PaymentBody).id).toBe((first.body as PaymentBody).id)
      expect(await owner.supplierPayment.count({ where: { supplierId } })).toBe(1)
      const reused = await asAdminA()
        .post(ApiRoutes.suppliers.recordPayment(supplierId))
        .send({ ...body, amountCents: 2000 })
      expect(errorOf(reused).metadata).toMatchObject({ conflict: PurchaseConflicts.KEY_REUSED })
      expect(
        (await pay(supplierId, { amountCents: 100, paidFromAccountId: accounts[INVENTORY] })).status
      ).toBe(BAD_REQUEST)
      const other = await supplier()
      expect(
        (await pay(other.id, { amountCents: 100, purchaseReceiptId: receipt.id })).status
      ).toBe(NOT_FOUND)
    })

    it('voids a payment with a reversing entry and the bill is owed again, once', async () => {
      const { supplierId, receipt } = await billed()
      const paid = await pay(supplierId, { amountCents: 10_000, purchaseReceiptId: receipt.id })
      const id = (paid.body as PaymentBody).id
      const voided = await asAdminA()
        .post(ApiRoutes.supplierPayments.void(id))
        .send({ reason: 'Wrong account' })
      expect(voided.status).toBe(CREATED)
      expect((voided.body as PaymentBody).voidedByEntryId).not.toBeNull()
      expect((await asAdminA().get(ApiRoutes.suppliers.balance(supplierId))).body).toMatchObject({
        openCents: 10_000,
        paidCents: 0
      })
      const again = await asAdminA()
        .post(ApiRoutes.supplierPayments.void(id))
        .send({ reason: 'Twice' })
      expect(again.status).toBe(CONFLICT)
      expect(errorOf(again).metadata).toMatchObject({
        conflict: PurchaseConflicts.PAYMENT_ALREADY_VOIDED
      })
      await waitForAuditEntries(owner, {
        action: AuditAction.SUPPLIER_PAYMENT_VOIDED,
        resourceId: id
      })
    })

    it('voids a payment once when two people void it at the same moment with other reasons', async () => {
      const { supplierId, receipt } = await billed()
      const paid = await pay(supplierId, { amountCents: 100, purchaseReceiptId: receipt.id })
      const id = (paid.body as PaymentBody).id

      const answers = await Promise.all(
        ['First reason', 'Another reason', 'A third one'].map(reason =>
          asAdminA().post(ApiRoutes.supplierPayments.void(id)).send({ reason })
        )
      )

      expect(answers.filter(answer => answer.status === CREATED)).toHaveLength(1)
      // The others are the typed refusal of the route, never the generic one of the books
      for (const answer of answers.filter(each => each.status !== CREATED)) {
        expect(answer.status).toBe(CONFLICT)
        expect(errorOf(answer).metadata).toMatchObject({
          conflict: PurchaseConflicts.PAYMENT_ALREADY_VOIDED
        })
      }
    })

    it('does not let the generic reversal touch the entry of a receipt or a payment', async () => {
      const { supplierId, receipt } = await billed()
      const paid = await pay(supplierId, { amountCents: 100, purchaseReceiptId: receipt.id })
      for (const entryId of [receipt.entryId, (paid.body as PaymentBody).entryId]) {
        const reversed = await asAdminA()
          .post(ApiRoutes.finance.entries.reverse(entryId))
          .send({ memo: 'Reverse it' })
        expect(reversed.status).toBe(CONFLICT)
        expect(errorOf(reversed).metadata).toMatchObject({
          conflict: PurchaseConflicts.ENTRY_OWNED_BY_PURCHASE
        })
      }
    })

    it('does not let another organization pay or void', async () => {
      const { supplierId, receipt } = await billed()
      expect(
        (await pay(supplierId, { amountCents: 100, purchaseReceiptId: receipt.id }, asAdminB()))
          .status
      ).toBe(NOT_FOUND)
      const paid = await pay(supplierId, { amountCents: 100 })
      expect(
        (
          await asAdminB()
            .post(ApiRoutes.supplierPayments.void((paid.body as PaymentBody).id))
            .send({ reason: 'No' })
        ).status
      ).toBe(NOT_FOUND)
    })

    it('keeps the payable account of a supplier that has bills', async () => {
      const { supplierId } = await billed()
      const payable = await owner.ledgerAccount.create({
        data: {
          organizationId: ctx.orgA.id,
          code: `29${randomUUID().slice(0, 4)}`,
          name: 'Other payable',
          type: AccountType.LIABILITY,
          normalSide: NormalSide.CREDIT
        },
        select: { id: true }
      })
      const changed = await asAdminA()
        .patch(ApiRoutes.suppliers.update(supplierId))
        .send({ defaultPayableAccountId: payable.id })
      expect(changed.status).toBe(CONFLICT)
      expect(errorOf(changed).code).toBe(ErrorCodes.SUPPLIER_HAS_HISTORY)
    })
  })

  describe('the books and the stock agree', () => {
    it('leaves the payable account of the supplier equal to what the payables say it owes', async () => {
      const seller = await supplier()
      const order = await placedOrder(seller.id)
      await receive(order.id, {
        supplierDocumentNumber: `D-${key()}`,
        lines: order.lines.map(line => ({ orderLineId: line.id, quantity: line.quantity }))
      })
      await pay(seller.id, { amountCents: 1000 })
      const owed = await asAdminA().get(ApiRoutes.suppliers.balance(seller.id))
      const ledger = await owner.journalLine.aggregate({
        where: { organizationId: ctx.orgA.id, partyType: PartyType.SUPPLIER, partyId: seller.id },
        _sum: { debitCents: true, creditCents: true }
      })
      expect((owed.body as BalanceBody).openCents).toBe(
        (ledger._sum.creditCents ?? 0) - (ledger._sum.debitCents ?? 0)
      )
    })
  })
})
