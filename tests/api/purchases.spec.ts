import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  AccountType,
  FinanceConflicts,
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
  bills: {
    receiptId: string
    openCents: number
    dueOn: string
    overdue: boolean
    daysOverdue: number
  }[]
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
    it('holds the shape of the tax id of the country when one is written, and leaves a saved one alone (FIN-212)', async () => {
      for (const taxId of ['x', '<script>', '01234567-9', '123456789012345']) {
        const refused = await asAdminA()
          .post(ApiRoutes.suppliers.create)
          .send({ name: `Shape ${taxId.length}`, taxId })
        expect(refused.status).toBe(BAD_REQUEST)
        expect(errorOf(refused).code).toBe(ErrorCodes.SUPPLIER_TAX_ID_INVALID)
      }
      // Made-up numbers: a national id with its check digit, a registration number
      const dui = await supplier({ name: 'Shape DUI', taxId: '01234567-8' })
      const nrc = await supplier({ name: 'Shape NRC', taxId: '123456-7' })

      const bad = await asAdminA().patch(ApiRoutes.suppliers.update(dui.id)).send({ taxId: 'x' })
      expect(bad.status).toBe(BAD_REQUEST)
      expect(errorOf(bad).code).toBe(ErrorCodes.SUPPLIER_TAX_ID_INVALID)
      const cleared = await asAdminA()
        .patch(ApiRoutes.suppliers.update(nrc.id))
        .send({ taxId: null })
      expect(cleared.status).toBe(OK)

      // A supplier saved before the rule keeps its tax id and can still be edited
      const legacy = await owner.supplier.create({
        data: { organizationId: ctx.orgA.id, name: 'Shape legacy', taxId: 'S-1234' }
      })
      const renamed = await asAdminA()
        .patch(ApiRoutes.suppliers.update(legacy.id))
        .send({ name: 'Shape legacy 2', taxId: 'S-1234' })
      expect(renamed.status).toBe(OK)
      expect((renamed.body as { taxId: string }).taxId).toBe('S-1234')
    })

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

    it('reads the wildcards of a name search as the characters they are', async () => {
      const tag = randomUUID().slice(0, 8)
      const literal = await supplier({ name: `Lik_${tag}%Uno` })
      const other = await supplier({ name: `LikXY${tag}ZUno` })
      const search = async (q: string): Promise<string[]> => {
        const res = await asAdminA().get(
          `${ApiRoutes.suppliers.list}?q=${encodeURIComponent(q)}&includeInactive=true`
        )
        expect(res.status).toBe(OK)
        return (res.body as { data: { id: string }[] }).data.map(row => row.id)
      }
      // "_" and "%" match only themselves: they are not "any one character" and "anything"
      expect(await search(`Lik_${tag}%Uno`)).toEqual([literal.id])
      expect(await search(`LIK_${tag}`)).toEqual([literal.id])
      expect(await search(`${tag}%`)).toEqual([literal.id])
      expect(await search(`${tag}Z`)).toEqual([other.id])
      expect(await search(`Lik_${tag}Z`)).toEqual([])
    })

    it('refuses a payable account that is not a liability', async () => {
      const response = await asAdminA()
        .post(ApiRoutes.suppliers.create)
        .send({ name: `S ${key()}`, defaultPayableAccountId: accounts[CASH] })
      expect(response.status).toBe(BAD_REQUEST)
    })

    it('does not let the payable account of a supplier be switched off or made a header (HC-120)', async () => {
      const payable = await owner.ledgerAccount.create({
        data: {
          organizationId: ctx.orgA.id,
          code: `28${randomUUID().slice(0, 6)}`,
          name: 'Payable of one supplier',
          type: AccountType.LIABILITY,
          normalSide: NormalSide.CREDIT
        },
        select: { id: true }
      })
      const created = await asAdminA()
        .post(ApiRoutes.suppliers.create)
        .send({ name: `S ${key()}`, defaultPayableAccountId: payable.id })
      expect(created.status).toBe(CREATED)

      const off = await asAdminA().post(ApiRoutes.finance.accounts.deactivate(payable.id))
      const header = await asAdminA()
        .patch(ApiRoutes.finance.accounts.byId(payable.id))
        .send({ isPostable: false })

      const retyped = await asAdminA()
        .patch(ApiRoutes.finance.accounts.byId(payable.id))
        .send({ type: AccountType.EXPENSE })

      for (const response of [off, header, retyped]) {
        expect(response.status).toBe(CONFLICT)
        expect(errorOf(response).metadata).toMatchObject({
          conflict: FinanceConflicts.ACCOUNT_IN_USE_BY_SETTING
        })
      }
      const row = await owner.ledgerAccount.findUniqueOrThrow({
        where: { id: payable.id },
        select: { active: true, isPostable: true }
      })
      expect(row).toEqual({ active: true, isPostable: true })

      // Once no supplier points at it, the account is free again
      const supplierId = (created.body as { id: string }).id
      const cleared = await asAdminA()
        .patch(ApiRoutes.suppliers.update(supplierId))
        .send({ defaultPayableAccountId: null })
      expect(cleared.status).toBe(OK)
      const freed = await asAdminA().post(ApiRoutes.finance.accounts.deactivate(payable.id))
      expect(freed.status).toBe(OK)
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
      expect(errorOf(cancel).metadata).toMatchObject({
        conflict: PurchaseConflicts.ORDER_HAS_RECEIPTS
      })
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

    it('receives an order whose tax rate was switched off after it was placed (HC-124)', async () => {
      const seller = await supplier()
      const rate = await asAdminA()
        .post(ApiRoutes.finance.taxRates.create)
        .send({
          code: `T${key().replaceAll('-', '').slice(0, 8)}`,
          name: 'Rate switched off later',
          rateBps: 500,
          outputAccountId: accounts['2201'],
          inputAccountId: accounts['1401']
        })
      expect(rate.status).toBe(CREATED)
      const rateId = (rate.body as { id: string }).id
      const item = await product()
      const order = await placedOrder(seller.id, {
        lines: [{ productId: item.id, quantity: 2, unitCostCents: 500, taxRateId: rateId }]
      })
      const off = await asAdminA().post(ApiRoutes.finance.taxRates.deactivate(rateId))
      expect(off.status).toBeLessThan(300)

      const received = await receive(order.id, {
        supplierDocumentNumber: `D-${key()}`,
        lines: [{ orderLineId: order.lines[0]?.id, quantity: 2 }]
      })

      expect(received.status).toBe(CREATED)
      // 2 x 5.00 at 5 %: the tax is posted, not read as zero
      expect((received.body as { receipts: ReceiptBody[] }).receipts[0]).toMatchObject({
        subtotalCents: 1000,
        taxCents: 50,
        totalCents: 1050
      })
    })

    it('reads the same invoice written with other capitals, spaces or hyphens as the same invoice (HC-124)', async () => {
      const seller = await supplier()
      const first = await placedOrder(seller.id)
      const second = await placedOrder(seller.id)
      const tag = key().replaceAll('-', '').slice(0, 8).toUpperCase()
      expect(
        (
          await receive(first.id, {
            supplierDocumentNumber: `FAC-${tag}`,
            lines: [{ orderLineId: first.lines[0]?.id, quantity: 1 }]
          })
        ).status
      ).toBe(CREATED)
      // The same order takes the rest of its invoice, however it is written; another supplier may have the same number
      const sameOrder = await receive(first.id, {
        supplierDocumentNumber: `fac ${tag.toLowerCase()}`,
        lines: [{ orderLineId: first.lines[0]?.id, quantity: 1 }]
      })
      expect(sameOrder.status).toBe(CREATED)
      const other = await supplier()
      const otherOrder = await placedOrder(other.id)
      const otherSupplier = await receive(otherOrder.id, {
        supplierDocumentNumber: `FAC-${tag}`,
        lines: [{ orderLineId: otherOrder.lines[0]?.id, quantity: 1 }]
      })
      expect(otherSupplier.status).toBe(CREATED)
      for (const variant of [`fac ${tag.toLowerCase()}`, `FAC${tag}`, ` Fac - ${tag} `]) {
        const elsewhere = await receive(second.id, {
          supplierDocumentNumber: variant,
          lines: [{ orderLineId: second.lines[0]?.id, quantity: 1 }]
        })
        expect(elsewhere.status).toBe(CONFLICT)
        expect(errorOf(elsewhere).metadata).toMatchObject({
          conflict: PurchaseConflicts.DOCUMENT_NUMBER_IN_USE
        })
      }
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

    it('does not let a caller end an order that has lines of a store they do not see (N-AA-03)', async () => {
      const seller = await supplier()
      const buyerOfOtherStore = api(
        app,
        await actorWithPermissions(owner, app, {
          prefix,
          name: 'buyer-store-a2-end',
          organizationId: ctx.orgA.id,
          storeId: ctx.storeA2.id,
          permissions: [Permissions.FINANCE_MANAGE_PURCHASES]
        }),
        ctx.storeA2
      )
      // An order that was only placed can be cancelled; one that arrived in part can be closed (the table of states, TDD_18 §3)
      const toCancel = await placedOrder(seller.id)
      const toClose = await placedOrder(seller.id)
      expect(
        (await receive(toClose.id, { lines: [{ orderLineId: toClose.lines[0]?.id, quantity: 1 }] }))
          .status
      ).toBeLessThan(BAD_REQUEST)
      for (const [order, route] of [
        [toCancel, ApiRoutes.purchaseOrders.cancel(toCancel.id)],
        [toClose, ApiRoutes.purchaseOrders.close(toClose.id)]
      ] as const) {
        const refused = await buyerOfOtherStore.post(route).send({})
        expect(refused.status).toBe(CONFLICT)
        expect(errorOf(refused).metadata).toMatchObject({
          conflict: PurchaseConflicts.LINE_STORE_NOT_VISIBLE
        })
        expect(
          (await owner.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } })).status
        ).not.toBe(PurchaseOrderStatus.CANCELLED)
        expect(
          (await owner.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } })).status
        ).not.toBe(PurchaseOrderStatus.CLOSED)
      }
      // Nothing changed: the people who see the lines can still receive them
      const received = await receive(toClose.id, {
        lines: [{ orderLineId: toClose.lines[0]?.id, quantity: 1 }]
      })
      expect(received.status).toBeLessThan(BAD_REQUEST)
    })

    it('does not let a caller end an order that has a line to arrive of another store, and lets them end one whose other lines arrived (N-AA-03)', async () => {
      const seller = await supplier()
      const mixed = await placedOrder(seller.id)
      // A line of a store the admin of store A does not see: the order is no longer wholly theirs
      const theirs = await createProduct(owner, { storeId: ctx.storeA2.id })
      const foreign = await owner.purchaseOrderLine.create({
        data: {
          organizationId: ctx.orgA.id,
          storeId: ctx.storeA2.id,
          purchaseOrderId: mixed.id,
          lineNo: 3,
          productId: theirs.id,
          quantity: 4,
          unitCostCents: 250
        }
      })
      const cancelled = await asAdminA().post(ApiRoutes.purchaseOrders.cancel(mixed.id)).send({})
      expect(cancelled.status).toBe(CONFLICT)
      expect(errorOf(cancelled).metadata).toMatchObject({
        conflict: PurchaseConflicts.LINE_STORE_NOT_VISIBLE
      })
      // Arrived in part, it can be closed, but not while the line of the other store is still to arrive
      expect(
        (await receive(mixed.id, { lines: [{ orderLineId: mixed.lines[0]?.id, quantity: 1 }] }))
          .status
      ).toBeLessThan(BAD_REQUEST)
      const refused = await asAdminA().post(ApiRoutes.purchaseOrders.close(mixed.id)).send({})
      expect(refused.status).toBe(CONFLICT)
      expect(errorOf(refused).metadata).toMatchObject({
        conflict: PurchaseConflicts.LINE_STORE_NOT_VISIBLE
      })
      // A line that arrived in full gives up nothing: the order whose only unseen line arrived can be tidied
      await owner.purchaseOrderLine.update({
        where: { id: foreign.id },
        data: { receivedQuantity: 4 }
      })
      const closed = await asAdminA().post(ApiRoutes.purchaseOrders.close(mixed.id)).send({})
      expect(closed.status).toBeLessThan(BAD_REQUEST)
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
        { receiptId: receipt.id, openCents: 10_000, dueOn: TODAY, overdue: false, daysOverdue: 0 }
      ])
    })

    it('says how late a bill is by the day of the books', async () => {
      const seller = await supplier({ paymentTermsDays: 0 })
      const order = await placedOrder(seller.id, {
        lines: [{ productId: (await product()).id, quantity: 1, unitCostCents: 1000 }]
      })
      const received = await receive(order.id, {
        supplierDocumentNumber: `D-${key()}`,
        receivedOn: isoDay(-5),
        lines: [{ orderLineId: order.lines[0]?.id, quantity: 1 }]
      })
      expect(received.status).toBe(CREATED)
      const payables = await asAdminA().get(
        `${ApiRoutes.suppliers.payables}?supplierId=${seller.id}&overdueOnly=true`
      )
      const [bill] = (payables.body as PayablesBody).bills
      // The day of the books is the one of the store furthest behind: up to a day before the UTC day
      expect(bill).toMatchObject({ dueOn: isoDay(-5), overdue: true })
      expect([4, 5]).toContain(bill?.daysOverdue)
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

    // Two bills of 5000 of the same supplier, the shape the invariants of HC-023 are checked on
    async function billedTwice(): Promise<{ supplierId: string; receipts: ReceiptBody[] }> {
      const seller = await supplier({ paymentTermsDays: 30 })
      const order = await placedOrder(seller.id, {
        lines: [{ productId: (await product()).id, quantity: 10, unitCostCents: 1000 }]
      })
      const receipts: ReceiptBody[] = []
      for (let part = 0; part < 2; part += 1) {
        const received = await receive(order.id, {
          supplierDocumentNumber: `D-${key()}`,
          lines: [{ orderLineId: order.lines[0]?.id, quantity: 5 }]
        })
        expect(received.status).toBe(CREATED)
        const latest = (received.body as OrderBody).receipts.find(
          each => !receipts.some(known => known.id === each.id)
        )
        if (latest === undefined) throw new Error('no receipt')
        receipts.push(latest)
      }
      return { supplierId: seller.id, receipts }
    }

    async function expectBooksHold(supplierId: string): Promise<BalanceBody> {
      const balance = (await asAdminA().get(ApiRoutes.suppliers.balance(supplierId)))
        .body as BalanceBody
      const payables = await asAdminA().get(
        `${ApiRoutes.suppliers.payables}?supplierId=${supplierId}`
      )
      const openOfBills = (payables.body as PayablesBody).bills.reduce(
        (sum, bill) => sum + bill.openCents,
        0
      )
      const live = await owner.supplierPayment.aggregate({
        where: { supplierId, voidedByEntryId: null },
        _sum: { amountCents: true }
      })
      // Never paid above billed, never open below zero, and the bills add up to the supplier
      expect(balance.paidCents).toBeLessThanOrEqual(balance.billedCents)
      expect(balance.openCents).toBeGreaterThanOrEqual(0)
      expect(balance.paidCents).toBe(live._sum.amountCents ?? 0)
      expect(openOfBills).toBe(balance.openCents)
      // The books agree with the subledger: what the supplier is owed on the payable account is the open balance
      const ledger = await owner.journalLine.aggregate({
        where: { partyType: 'supplier', partyId: supplierId, account: { code: PAYABLE } },
        _sum: { debitCents: true, creditCents: true }
      })
      expect((ledger._sum.creditCents ?? 0) - (ledger._sum.debitCents ?? 0)).toBe(balance.openCents)
      for (const bill of (payables.body as PayablesBody).bills) {
        expect(bill.openCents).toBeGreaterThanOrEqual(0)
      }
      return balance
    }

    it('never pays above what is billed nor leaves a bill open below zero, with named and unnamed payments', async () => {
      const { supplierId, receipts } = await billedTwice()
      const second = receipts[1]
      if (second === undefined) throw new Error('no receipt')
      expect((await pay(supplierId, { amountCents: 7000 })).status).toBe(CREATED)
      expect(
        (await pay(supplierId, { amountCents: 3000, purchaseReceiptId: second.id })).status
      ).toBe(CREATED)
      expect(await expectBooksHold(supplierId)).toMatchObject({
        billedCents: 10_000,
        paidCents: 10_000,
        openCents: 0
      })
      for (const body of [{ amountCents: 1 }, { amountCents: 1, purchaseReceiptId: second.id }]) {
        const refused = await pay(supplierId, body)
        expect(refused.status).toBe(CONFLICT)
        expect([
          PurchaseConflicts.PAYMENT_EXCEEDS_BALANCE,
          PurchaseConflicts.PAYMENT_EXCEEDS_RECEIPT
        ]).toContain((errorOf(refused).metadata as { conflict?: string }).conflict)
      }
      await expectBooksHold(supplierId)
    })

    it('keeps the books when a payment is voided and others are made at the same moment', async () => {
      const { supplierId, receipts } = await billedTwice()
      const first = receipts[0]
      if (first === undefined) throw new Error('no receipt')
      const earlier = await pay(supplierId, { amountCents: 4000 })
      expect(earlier.status).toBe(CREATED)

      // Any order of the payments is valid as long as the books hold: one above what is owed at its turn is refused
      const answers = await Promise.all([
        asAdminA()
          .post(ApiRoutes.supplierPayments.void((earlier.body as PaymentBody).id))
          .send({ reason: 'Race' }),
        pay(supplierId, { amountCents: 10_000 }),
        pay(supplierId, { amountCents: 5000, purchaseReceiptId: first.id })
      ])
      for (const answer of answers) expect([CREATED, CONFLICT]).toContain(answer.status)
      for (const answer of answers.filter(each => each.status === CONFLICT)) {
        expect([
          PurchaseConflicts.PAYMENT_EXCEEDS_BALANCE,
          PurchaseConflicts.PAYMENT_EXCEEDS_RECEIPT
        ]).toContain((errorOf(answer).metadata as { conflict?: string }).conflict)
      }
      expect(answers[0].status).toBe(CREATED)
      const balance = await expectBooksHold(supplierId)
      expect(balance.billedCents).toBe(10_000)
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

    it('does not answer the retry of a payment that was voided with the voided payment (HC-213)', async () => {
      const { supplierId, receipt } = await billed()
      const idempotencyKey = key()
      const body = { amountCents: 10_000, purchaseReceiptId: receipt.id, idempotencyKey }
      const paid = await pay(supplierId, body)
      expect(paid.status).toBe(CREATED)
      const voided = await asAdminA()
        .post(ApiRoutes.supplierPayments.void((paid.body as PaymentBody).id))
        .send({ reason: 'Wrong account' })
      expect(voided.status).toBe(CREATED)
      expect((voided.body as PaymentBody).voidedByEntryId).not.toBeNull()

      const retry = await pay(supplierId, body)

      expect(retry.status).toBe(CONFLICT)
      expect(errorOf(retry).metadata).toMatchObject({
        conflict: PurchaseConflicts.PAYMENT_ALREADY_VOIDED
      })
      // Nothing was posted again: the bill is still owed in full and no second payment exists
      expect((await asAdminA().get(ApiRoutes.suppliers.balance(supplierId))).body).toMatchObject({
        openCents: 10_000,
        paidCents: 0
      })
      expect(await owner.supplierPayment.count({ where: { supplierId } })).toBe(1)
    })

    it('still answers the same payment to the retry of one that is live', async () => {
      const { supplierId, receipt } = await billed()
      const body = { amountCents: 100, purchaseReceiptId: receipt.id, idempotencyKey: key() }
      const live = await pay(supplierId, body)
      const replay = await pay(supplierId, body)
      expect(live.status).toBe(CREATED)
      expect(replay.status).toBe(CREATED)
      expect((replay.body as PaymentBody).id).toBe((live.body as PaymentBody).id)
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

  describe('a supplier gives a payment back (E11b, HC-121)', () => {
    interface ReturnBody {
      id: string
      supplierPaymentId: string
      amountCents: number
      entryId: string
      voidedByEntryId: string | null
    }
    async function paidBill(
      amountCents = 10_000
    ): Promise<{ supplierId: string; paymentId: string; receiptId: string }> {
      const seller = await supplier()
      const order = await placedOrder(seller.id, {
        lines: [{ productId: (await product()).id, quantity: 10, unitCostCents: 1000 }]
      })
      const received = await receive(order.id, {
        supplierDocumentNumber: `D-${key()}`,
        lines: [{ orderLineId: order.lines[0]?.id, quantity: 10 }]
      })
      const receipt = (received.body as OrderBody).receipts[0]
      if (receipt === undefined) throw new Error('no receipt')
      const paid = await pay(seller.id, { amountCents, purchaseReceiptId: receipt.id })
      expect(paid.status).toBe(CREATED)
      return {
        supplierId: seller.id,
        paymentId: (paid.body as PaymentBody).id,
        receiptId: receipt.id
      }
    }
    const giveBack = (paymentId: string, body: Record<string, unknown>, who = asAdminA()) =>
      who.post(ApiRoutes.supplierPayments.returns(paymentId)).send({
        idempotencyKey: key(),
        receivedIntoAccountId: accounts[BANK],
        returnedOn: TODAY,
        ...body
      })
    const balanceOf = async (supplierId: string): Promise<BalanceBody> =>
      (await asAdminA().get(ApiRoutes.suppliers.balance(supplierId))).body as BalanceBody

    it('owes the debt again by what came back, with one entry the bank can match', async () => {
      const { supplierId, paymentId, receiptId } = await paidBill()
      expect(await balanceOf(supplierId)).toMatchObject({ paidCents: 10_000, openCents: 0 })

      const returned = await giveBack(paymentId, { amountCents: 4000, reference: 'Bounced' })

      expect(returned.status).toBe(CREATED)
      const body = returned.body as ReturnBody
      expect(await linesOf(body.entryId)).toEqual([
        [BANK, 4000, 0],
        [PAYABLE, 0, 4000]
      ])
      const entry = await owner.journalEntry.findUniqueOrThrow({ where: { id: body.entryId } })
      expect(entry).toMatchObject({
        type: JournalEntryType.SUPPLIER_PAYMENT_RETURN,
        sourceId: body.id,
        idempotencyKey: `payment_return:${body.id}`
      })
      expect(await balanceOf(supplierId)).toMatchObject({ paidCents: 6000, openCents: 4000 })
      // The bill is open again by 4000 and no more
      const payables = await asAdminA().get(
        `${ApiRoutes.suppliers.payables}?supplierId=${supplierId}`
      )
      expect((payables.body as PayablesBody).bills).toMatchObject([{ receiptId, openCents: 4000 }])
      expect(
        (await pay(supplierId, { amountCents: 4001, purchaseReceiptId: receiptId })).status
      ).toBe(CONFLICT)
      expect(
        (await pay(supplierId, { amountCents: 4000, purchaseReceiptId: receiptId })).status
      ).toBe(CREATED)
      // The payable account of the books says what the payables say
      const ledger = await owner.journalLine.aggregate({
        where: { organizationId: ctx.orgA.id, partyType: PartyType.SUPPLIER, partyId: supplierId },
        _sum: { debitCents: true, creditCents: true }
      })
      expect((await balanceOf(supplierId)).openCents).toBe(
        (ledger._sum.creditCents ?? 0) - (ledger._sum.debitCents ?? 0)
      )
      await waitForAuditEntries(owner, {
        action: AuditAction.SUPPLIER_PAYMENT_RETURNED,
        resourceId: body.id
      })
      const listed = await asAdminA().get(ApiRoutes.supplierPayments.returns(paymentId))
      expect((listed.body as { data: { id: string }[] }).data.map(row => row.id)).toEqual([body.id])
    })

    it('is one return for a retry and refuses the key of another request', async () => {
      const { paymentId } = await paidBill()
      const body = { idempotencyKey: key(), amountCents: 1000 }
      const first = await giveBack(paymentId, body)
      const retry = await giveBack(paymentId, body)
      expect((retry.body as ReturnBody).id).toBe((first.body as ReturnBody).id)
      expect(
        await owner.supplierPaymentReturn.count({ where: { supplierPaymentId: paymentId } })
      ).toBe(1)
      const reused = await giveBack(paymentId, { ...body, amountCents: 2000 })
      expect(reused.status).toBe(CONFLICT)
      expect(errorOf(reused).metadata).toMatchObject({ conflict: PurchaseConflicts.KEY_REUSED })
    })

    it('refuses more than the payment, a day before it, a future day and an account that is not cash', async () => {
      const { paymentId } = await paidBill()
      expect((await giveBack(paymentId, { amountCents: 6000 })).status).toBe(CREATED)
      const over = await giveBack(paymentId, { amountCents: 4001 })
      expect(over.status).toBe(CONFLICT)
      expect(errorOf(over).metadata).toMatchObject({
        conflict: PurchaseConflicts.RETURN_EXCEEDS_PAYMENT,
        leftCents: 4000
      })
      expect((await giveBack(paymentId, { amountCents: 100, returnedOn: isoDay(-5) })).status).toBe(
        BAD_REQUEST
      )
      expect((await giveBack(paymentId, { amountCents: 100, returnedOn: isoDay(30) })).status).toBe(
        BAD_REQUEST
      )
      expect(
        (
          await giveBack(paymentId, {
            amountCents: 100,
            receivedIntoAccountId: accounts[INVENTORY]
          })
        ).status
      ).toBe(BAD_REQUEST)
      expect((await giveBack(randomUUID(), { amountCents: 100 })).status).toBe(NOT_FOUND)
    })

    it('never gives back more than the payment when three returns arrive at the same moment', async () => {
      const { paymentId } = await paidBill()

      const answers = await Promise.all(
        [1, 2, 3].map(() => giveBack(paymentId, { amountCents: 5000 }))
      )

      expect(answers.filter(answer => answer.status === CREATED)).toHaveLength(2)
      for (const refused of answers.filter(answer => answer.status !== CREATED)) {
        expect(refused.status).toBe(CONFLICT)
        expect(errorOf(refused).metadata).toMatchObject({
          conflict: PurchaseConflicts.RETURN_EXCEEDS_PAYMENT
        })
      }
      const sum = await owner.supplierPaymentReturn.aggregate({
        where: { supplierPaymentId: paymentId },
        _sum: { amountCents: true }
      })
      expect(sum._sum.amountCents).toBe(10_000)
    })

    it('voids a return once, with a reversing entry, and the debt goes back to what it was', async () => {
      const { supplierId, paymentId } = await paidBill()
      const returned = (await giveBack(paymentId, { amountCents: 3000 })).body as ReturnBody
      const voided = await asAdminA()
        .post(ApiRoutes.supplierPaymentReturns.void(returned.id))
        .send({ reason: 'The bank corrected it' })
      expect(voided.status).toBe(CREATED)
      expect((voided.body as ReturnBody).voidedByEntryId).not.toBeNull()
      expect(await balanceOf(supplierId)).toMatchObject({ paidCents: 10_000, openCents: 0 })
      const again = await asAdminA()
        .post(ApiRoutes.supplierPaymentReturns.void(returned.id))
        .send({ reason: 'Twice' })
      expect(again.status).toBe(CONFLICT)
      expect(errorOf(again).metadata).toMatchObject({
        conflict: PurchaseConflicts.RETURN_ALREADY_VOIDED
      })
      // The retry of a voided return is not answered with it
      const retry = await giveBack(paymentId, {
        idempotencyKey: (
          await owner.supplierPaymentReturn.findUniqueOrThrow({ where: { id: returned.id } })
        ).clientKey,
        amountCents: 3000
      })
      expect(retry.status).toBe(CONFLICT)
      // ... and the room it took is free again
      expect((await giveBack(paymentId, { amountCents: 10_000 })).status).toBe(CREATED)
    })

    it('does not void a return whose debt was paid again: the payments would pass what is owed', async () => {
      const { supplierId, paymentId, receiptId } = await paidBill()
      const returned = (await giveBack(paymentId, { amountCents: 10_000 })).body as ReturnBody
      expect(
        (await pay(supplierId, { amountCents: 10_000, purchaseReceiptId: receiptId })).status
      ).toBe(CREATED)

      const voided = await asAdminA()
        .post(ApiRoutes.supplierPaymentReturns.void(returned.id))
        .send({ reason: 'Too late' })

      expect(voided.status).toBe(CONFLICT)
      expect(errorOf(voided).metadata).toMatchObject({
        conflict: PurchaseConflicts.RETURN_VOID_WOULD_OVERPAY,
        openCents: 0
      })
      expect(await balanceOf(supplierId)).toMatchObject({ paidCents: 10_000, openCents: 0 })
    })

    it('audits the void of a return and asks for the permission of the payment', async () => {
      const { paymentId } = await paidBill()
      const returned = (await giveBack(paymentId, { amountCents: 700 })).body as ReturnBody
      const buyer = await asRole('returns-void-buyer', [Permissions.FINANCE_MANAGE_PURCHASES])
      const refused = await buyer
        .post(ApiRoutes.supplierPaymentReturns.void(returned.id))
        .send({ reason: 'No money rights' })
      expect(refused.status).toBe(FORBIDDEN)
      const voided = await asAdminA()
        .post(ApiRoutes.supplierPaymentReturns.void(returned.id))
        .send({ reason: 'Wrong amount' })
      expect(voided.status).toBe(CREATED)
      await waitForAuditEntries(owner, {
        action: AuditAction.SUPPLIER_PAYMENT_RETURN_VOIDED,
        resourceId: returned.id
      })
    })

    it('voids a payment only after its returns, and gives nothing back of a voided payment', async () => {
      const { paymentId } = await paidBill()
      const returned = (await giveBack(paymentId, { amountCents: 2000 })).body as ReturnBody
      const refused = await asAdminA()
        .post(ApiRoutes.supplierPayments.void(paymentId))
        .send({ reason: 'Too early' })
      expect(refused.status).toBe(CONFLICT)
      expect(errorOf(refused).metadata).toMatchObject({
        conflict: PurchaseConflicts.PAYMENT_HAS_RETURNS
      })
      await asAdminA()
        .post(ApiRoutes.supplierPaymentReturns.void(returned.id))
        .send({ reason: 'First the return' })
      const voided = await asAdminA()
        .post(ApiRoutes.supplierPayments.void(paymentId))
        .send({ reason: 'Now the payment' })
      expect(voided.status).toBe(CREATED)
      const late = await giveBack(paymentId, { amountCents: 100 })
      expect(late.status).toBe(CONFLICT)
      expect(errorOf(late).metadata).toMatchObject({ conflict: PurchaseConflicts.PAYMENT_VOIDED })
    })

    it('keeps the entry of a return out of a reversal made alone, and the route out of other hands', async () => {
      const { paymentId } = await paidBill()
      const returned = (await giveBack(paymentId, { amountCents: 500 })).body as ReturnBody
      const reversed = await asAdminA()
        .post(ApiRoutes.finance.entries.reverse(returned.entryId))
        .send({ memo: 'Reverse it' })
      expect(reversed.status).toBe(CONFLICT)
      expect(errorOf(reversed).metadata).toMatchObject({
        conflict: PurchaseConflicts.ENTRY_OWNED_BY_PURCHASE
      })
      // Another organization neither sees the payment nor gives anything back of it
      expect((await giveBack(paymentId, { amountCents: 100 }, asAdminB())).status).toBe(NOT_FOUND)
      expect((await asAdminB().get(ApiRoutes.supplierPayments.returns(paymentId))).status).toBe(
        NOT_FOUND
      )
      expect(
        (
          await asAdminB()
            .post(ApiRoutes.supplierPaymentReturns.void(returned.id))
            .send({ reason: 'Not mine' })
        ).status
      ).toBe(NOT_FOUND)
      // Moving money is the permission of the payment: managing purchases alone does not give money back
      const buyer = await asRole('returns-buyer', [Permissions.FINANCE_MANAGE_PURCHASES])
      expect((await giveBack(paymentId, { amountCents: 100 }, buyer)).status).toBe(FORBIDDEN)
      expect((await buyer.get(ApiRoutes.supplierPayments.returns(paymentId))).status).toBe(OK)
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
