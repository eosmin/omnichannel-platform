import { randomUUID } from 'node:crypto'

import { ensureStore, type OwnerClient } from '@platform/core/database-testing'
import { FinanceSourceType, JournalEntryType, PurchaseOrderStatus } from '@platform/core/domain'

import {
  createFinanceFixture,
  createProduct,
  createWarehouse,
  day,
  type FinanceFixture,
  postTestEntry,
  simpleEntry
} from '../builders'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

// What the database itself guarantees about suppliers, purchases and what is paid for them (TDD_18 §2.7, Step 4B.5), before any service
// writes to them: the rules the books stand on, so that a bug of a service cannot break them. Each case writes as the owner of the
// database, which no privilege holds back: what refuses it is the table itself.
describe('The tables of purchases', () => {
  const prefix = newRunPrefix()
  let owner: OwnerClient
  let orgId = ''
  let books: FinanceFixture
  let storeId = ''

  beforeAll(async () => {
    owner = ownerClient()
    const org = await owner.organization.create({
      data: { name: `${prefix}-a`, slug: `${prefix}-a` }
    })
    orgId = org.id
    storeId = (await ensureStore(owner, orgId, `${prefix}-store`)).id
    books = await createFinanceFixture(owner, orgId)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await owner.$disconnect()
  })

  const supplier = (name = `Supplier ${randomUUID().slice(0, 8)}`) =>
    owner.supplier.create({ data: { organizationId: orgId, name }, select: { id: true } })

  async function order(supplierId: string): Promise<{ id: string; lineId: string }> {
    const warehouse = await createWarehouse(owner, { organizationId: orgId })
    const product = await createProduct(owner, { storeId })
    const id = randomUUID()
    await owner.purchaseOrder.create({
      data: {
        id,
        organizationId: orgId,
        number: `T-${id.slice(0, 8)}`,
        supplierId,
        warehouseId: warehouse.id,
        status: PurchaseOrderStatus.ORDERED,
        orderedOn: day('2026-11-10'),
        clientKey: `k-${id}`,
        createdBy: 'schema-suite'
      }
    })
    const line = await owner.purchaseOrderLine.create({
      data: {
        organizationId: orgId,
        storeId,
        purchaseOrderId: id,
        lineNo: 1,
        productId: product.id,
        quantity: 5,
        unitCostCents: 200
      },
      select: { id: true }
    })
    return { id, lineId: line.id }
  }

  const receiptEntry = (id: string, cents = 1000) =>
    postTestEntry(
      owner,
      simpleEntry(books, cents, {
        type: JournalEntryType.PURCHASE_RECEIPT,
        sourceType: FinanceSourceType.PURCHASE_RECEIPT,
        sourceId: id
      })
    )
  const paymentEntry = (id: string, cents = 500) =>
    postTestEntry(
      owner,
      simpleEntry(books, cents, {
        type: JournalEntryType.SUPPLIER_PAYMENT,
        sourceType: FinanceSourceType.SUPPLIER_PAYMENT,
        sourceId: id
      })
    )

  async function receipt(
    supplierId: string,
    purchaseOrderId: string,
    extra: Partial<{
      totalCents: number
      subtotalCents: number
      taxCents: number
      entryId: string
    }> = {}
  ): Promise<{ id: string; entryId: string }> {
    const id = randomUUID()
    const entry =
      extra.entryId === undefined
        ? await receiptEntry(id, extra.totalCents ?? 1000)
        : { id: extra.entryId }
    await owner.purchaseReceipt.create({
      data: {
        id,
        organizationId: orgId,
        purchaseOrderId,
        supplierId,
        receivedOn: day('2026-11-10'),
        dueOn: day('2026-11-10'),
        taxCreditable: false,
        subtotalCents: extra.subtotalCents ?? 1000,
        taxCents: extra.taxCents ?? 0,
        totalCents: extra.totalCents ?? 1000,
        clientKey: `k-${id}`,
        entryId: entry.id,
        createdBy: 'schema-suite'
      }
    })
    return { id, entryId: entry.id }
  }

  async function payment(
    supplierId: string,
    extra: Partial<{ paidFromAccountId: string; purchaseReceiptId: string }> = {}
  ): Promise<{ id: string; entryId: string }> {
    const id = randomUUID()
    const entry = await paymentEntry(id)
    await owner.supplierPayment.create({
      data: {
        id,
        organizationId: orgId,
        supplierId,
        paidFromAccountId: extra.paidFromAccountId ?? books.accounts.cash,
        ...(extra.purchaseReceiptId === undefined
          ? {}
          : { purchaseReceiptId: extra.purchaseReceiptId }),
        amountCents: 500,
        paidOn: day('2026-11-10'),
        clientKey: `k-${id}`,
        entryId: entry.id,
        createdBy: 'schema-suite'
      }
    })
    return { id, entryId: entry.id }
  }

  describe('a supplier', () => {
    it('has a name that is unique per organization ignoring case', async () => {
      await supplier('Casa Uno')
      await expect(supplier('CASA UNO')).rejects.toThrow(
        /uq_suppliers_org_lower_name|Unique constraint/
      )
    })

    it('keeps its terms inside the range', async () => {
      await expect(
        owner.supplier.create({
          data: { organizationId: orgId, name: 'Slow', paymentTermsDays: 366 }
        })
      ).rejects.toThrow(/chk_suppliers_terms/)
    })
  })

  describe('an order line', () => {
    it('is never received above what was ordered', async () => {
      const { lineId } = await order((await supplier()).id)
      await expect(
        owner.purchaseOrderLine.update({ where: { id: lineId }, data: { receivedQuantity: 6 } })
      ).rejects.toThrow(/chk_purchase_order_lines_received/)
    })

    it('takes a whole number of units above zero', async () => {
      const seller = await supplier()
      const { id } = await order(seller.id)
      const product = await createProduct(owner, { storeId })
      await expect(
        owner.purchaseOrderLine.create({
          data: {
            organizationId: orgId,
            storeId,
            purchaseOrderId: id,
            lineNo: 2,
            productId: product.id,
            quantity: 0,
            unitCostCents: 1
          }
        })
      ).rejects.toThrow(/chk_purchase_order_lines_quantity/)
    })
  })

  describe('a receipt', () => {
    it('is written with the entry that posts it, for its total and its day', async () => {
      const seller = await supplier()
      const { id } = await order(seller.id)
      const written = await receipt(seller.id, id)
      expect(
        await owner.purchaseReceipt.findUniqueOrThrow({ where: { id: written.id } })
      ).toMatchObject({
        totalCents: 1000
      })
    })

    it('refuses an entry that is not its own: another total, another type', async () => {
      const seller = await supplier()
      const { id } = await order(seller.id)
      const other = randomUUID()
      const wrongTotal = await receiptEntry(other, 999)
      await expect(
        owner.purchaseReceipt.create({
          data: {
            id: other,
            organizationId: orgId,
            purchaseOrderId: id,
            supplierId: seller.id,
            receivedOn: day('2026-11-10'),
            dueOn: day('2026-11-10'),
            taxCreditable: false,
            subtotalCents: 1000,
            taxCents: 0,
            totalCents: 1000,
            clientKey: `k-${other}`,
            entryId: wrongTotal.id,
            createdBy: 'schema-suite'
          }
        })
      ).rejects.toThrow(/PURCHASE_RECEIPT_ENTRY/)
      const manual = await postTestEntry(owner, simpleEntry(books, 1000))
      await expect(receipt(seller.id, id, { entryId: manual.id })).rejects.toThrow(
        /PURCHASE_RECEIPT_ENTRY/
      )
    })

    it('is of the supplier of its order', async () => {
      const seller = await supplier()
      const { id } = await order(seller.id)
      const stranger = await supplier()
      await expect(receipt(stranger.id, id)).rejects.toThrow(/PURCHASE_RECEIPT_ORDER/)
    })

    it('owes what its parts add up to, and a creditable tax needs a document', async () => {
      const seller = await supplier()
      const { id } = await order(seller.id)
      await expect(receipt(seller.id, id, { totalCents: 1001 })).rejects.toThrow(
        /chk_purchase_receipts_money/
      )
      const receiptId = randomUUID()
      const entryId = (await receiptEntry(receiptId)).id
      await expect(
        owner.purchaseReceipt.create({
          data: {
            id: receiptId,
            organizationId: orgId,
            purchaseOrderId: id,
            supplierId: seller.id,
            receivedOn: day('2026-11-10'),
            dueOn: day('2026-11-10'),
            taxCreditable: true,
            subtotalCents: 1000,
            taxCents: 0,
            totalCents: 1000,
            clientKey: `k-${randomUUID()}`,
            entryId,
            createdBy: 'schema-suite'
          }
        })
      ).rejects.toThrow(/chk_purchase_receipts_creditable/)
    })

    it('is never changed, deleted or emptied, even by the owner of the database', async () => {
      const seller = await supplier()
      const { id } = await order(seller.id)
      const written = await receipt(seller.id, id)
      await expect(
        owner.purchaseReceipt.update({ where: { id: written.id }, data: { totalCents: 1 } })
      ).rejects.toThrow(/PURCHASE_IMMUTABLE/)
      await expect(owner.purchaseReceipt.delete({ where: { id: written.id } })).rejects.toThrow(
        /PURCHASE_IMMUTABLE/
      )

      await expect(owner.$executeRawUnsafe('TRUNCATE purchase_receipts CASCADE')).rejects.toThrow(
        /PURCHASE_IMMUTABLE/
      )
    })
  })

  describe('a supplier payment', () => {
    it('comes from a cash, bank or wallet account', async () => {
      const seller = await supplier()
      await expect(
        payment(seller.id, { paidFromAccountId: books.accounts.expense })
      ).rejects.toThrow(/SUPPLIER_PAYMENT_ACCOUNT/)
    })

    it('names a bill of its own supplier', async () => {
      const seller = await supplier()
      const { id } = await order(seller.id)
      const bill = await receipt(seller.id, id)
      const stranger = await supplier()
      await expect(payment(stranger.id, { purchaseReceiptId: bill.id })).rejects.toThrow(
        /SUPPLIER_PAYMENT_BILL/
      )
    })

    it('is voided once, by the reversal of its own entry, and changes in nothing else', async () => {
      const seller = await supplier()
      const paid = await payment(seller.id)
      await expect(
        owner.supplierPayment.update({ where: { id: paid.id }, data: { amountCents: 1 } })
      ).rejects.toThrow(/SUPPLIER_PAYMENT_IMMUTABLE/)
      // A pointer to an entry that is not the reversal of its own
      const unrelated = await postTestEntry(owner, simpleEntry(books, 500))
      await expect(
        owner.supplierPayment.update({
          where: { id: paid.id },
          data: { voidedByEntryId: unrelated.id }
        })
      ).rejects.toThrow(/SUPPLIER_PAYMENT_ENTRY/)
      await expect(owner.supplierPayment.delete({ where: { id: paid.id } })).rejects.toThrow(
        /PURCHASE_IMMUTABLE/
      )
    })
  })

  describe('the return of a supplier payment (HC-121)', () => {
    async function giveBack(
      paymentId: string,
      supplierId: string,
      extra: Partial<{
        amountCents: number
        receivedIntoAccountId: string
        returnedOn: string
        entryCents: number
      }> = {}
    ): Promise<{ id: string; entryId: string }> {
      const id = randomUUID()
      const amountCents = extra.amountCents ?? 200
      const entry = await postTestEntry(
        owner,
        simpleEntry(books, extra.entryCents ?? amountCents, {
          type: JournalEntryType.SUPPLIER_PAYMENT_RETURN,
          sourceType: FinanceSourceType.SUPPLIER_PAYMENT_RETURN,
          sourceId: id
        })
      )
      await owner.supplierPaymentReturn.create({
        data: {
          id,
          organizationId: orgId,
          supplierId,
          supplierPaymentId: paymentId,
          receivedIntoAccountId: extra.receivedIntoAccountId ?? books.accounts.cash,
          amountCents,
          returnedOn: day(extra.returnedOn ?? '2026-11-10'),
          clientKey: `k-${id}`,
          entryId: entry.id,
          createdBy: 'schema-suite'
        }
      })
      return { id, entryId: entry.id }
    }

    it('comes back into a cash, bank or wallet account', async () => {
      const seller = await supplier()
      const paid = await payment(seller.id)
      await expect(
        giveBack(paid.id, seller.id, { receivedIntoAccountId: books.accounts.expense })
      ).rejects.toThrow(/SUPPLIER_PAYMENT_RETURN_ACCOUNT/)
    })

    it('is of a payment of its own supplier, never before it and never for more than it was', async () => {
      const seller = await supplier()
      const stranger = await supplier()
      const paid = await payment(seller.id)
      await expect(giveBack(paid.id, stranger.id)).rejects.toThrow(
        /SUPPLIER_PAYMENT_RETURN_PAYMENT/
      )
      await expect(giveBack(paid.id, seller.id, { returnedOn: '2026-11-09' })).rejects.toThrow(
        /SUPPLIER_PAYMENT_RETURN_PAYMENT/
      )
      await giveBack(paid.id, seller.id, { amountCents: 300 })
      await expect(giveBack(paid.id, seller.id, { amountCents: 201 })).rejects.toThrow(
        /SUPPLIER_PAYMENT_RETURN_AMOUNT/
      )
      await giveBack(paid.id, seller.id, { amountCents: 200 })
    })

    it('posts the entry of its own: its amount, its day and its kind', async () => {
      const seller = await supplier()
      const paid = await payment(seller.id)
      await expect(
        giveBack(paid.id, seller.id, { amountCents: 200, entryCents: 100 })
      ).rejects.toThrow(/SUPPLIER_PAYMENT_RETURN_ENTRY/)
    })

    it('is voided once and never changed or deleted', async () => {
      const seller = await supplier()
      const paid = await payment(seller.id)
      const given = await giveBack(paid.id, seller.id)
      await expect(
        owner.supplierPaymentReturn.update({ where: { id: given.id }, data: { amountCents: 1 } })
      ).rejects.toThrow(/SUPPLIER_PAYMENT_RETURN_IMMUTABLE/)
      const unrelated = await postTestEntry(owner, simpleEntry(books, 200))
      await expect(
        owner.supplierPaymentReturn.update({
          where: { id: given.id },
          data: { voidedByEntryId: unrelated.id }
        })
      ).rejects.toThrow(/SUPPLIER_PAYMENT_RETURN_ENTRY/)
      await expect(owner.supplierPaymentReturn.delete({ where: { id: given.id } })).rejects.toThrow(
        /PURCHASE_IMMUTABLE/
      )
    })
  })

  describe('the roles of the application', () => {
    it('add receipts and payments, point a payment at its voiding entry, and change or remove nothing else', async () => {
      const allowed = async (role: string, table: string, privilege: string): Promise<boolean> =>
        (
          await owner.$queryRaw<{ allowed: boolean }[]>`
            SELECT has_table_privilege(${role}, ${table}, ${privilege}) AS allowed`
        )[0]?.allowed === true
      const column = async (role: string, name: string): Promise<boolean> =>
        (
          await owner.$queryRaw<{ allowed: boolean }[]>`
            SELECT has_column_privilege(${role}, 'supplier_payments', ${name}, 'UPDATE') AS allowed`
        )[0]?.allowed === true
      for (const role of ['platform_app', 'platform_worker']) {
        for (const table of [
          'purchase_receipts',
          'purchase_receipt_lines',
          'supplier_payments',
          'supplier_payment_returns'
        ]) {
          expect(await allowed(role, table, 'SELECT')).toBe(true)
          expect(await allowed(role, table, 'INSERT')).toBe(true)
          for (const privilege of ['UPDATE', 'DELETE', 'TRUNCATE']) {
            expect({
              role,
              table,
              privilege,
              allowed: await allowed(role, table, privilege)
            }).toEqual({
              role,
              table,
              privilege,
              allowed: false
            })
          }
        }
        expect(await column(role, 'voided_by_entry_id')).toBe(true)
        for (const name of ['amount_cents', 'entry_id', 'supplier_id', 'paid_from_account_id']) {
          expect({ role, name, allowed: await column(role, name) }).toEqual({
            role,
            name,
            allowed: false
          })
        }
      }
    })
  })
})
