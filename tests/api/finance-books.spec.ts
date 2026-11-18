import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  FinanceCountryCodes,
  FinancePostingKey,
  FinanceSourceType,
  JournalEntryType,
  LegalBookField,
  LegalBookKind,
  PurchaseOrderStatus
} from '@platform/core/domain'
import { SimulatorDocumentTypes } from '@platform/fiscal/simulator'

import { createPeriod, postTestEntry } from '../builders/finance'
import { createOrder } from '../builders/order'
import { createWarehouse } from '../builders/warehouse'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

interface BookBody {
  kind: string
  period: { id: string; status: string }
  layout: { version: number; source: string; accountantConfirmed: boolean }
  unvalidated: boolean
  header: string[]
  rows: (string | number | boolean | null)[][]
  totals: Record<string, number>
  warnings: Record<string, number>
  contentSha256: string
  frozen: boolean
}
interface LayoutBody {
  kind: string
  version: number
  source: string
  accountantConfirmed: boolean
  columns: { field: string; label: string | null }[]
}

const OK = 200
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const START = '2026-01-01'
const CASH = '1101'
const SALES = '4101'
const INVENTORY = '1301'
const PAYABLE = '2101'

describe('The legal books', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let accountsA: Record<string, string> = {}
  let januaryA = ''
  let supplierId = ''
  const orders: { taxpayer: string; consumer: string; unissued: string } = {
    taxpayer: '',
    consumer: '',
    unissued: ''
  }

  let sequence = 1000
  const asAdminA = () => api(app, ctx.adminA, ctx.storeA)
  const asAdminB = () => api(app, ctx.adminB, ctx.storeB)
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

  const book = async (kind: LegalBookKind, query = ''): Promise<BookBody> => {
    const response = await asAdminA().get(
      `${ApiRoutes.finance.books.byKind(kind)}?periodId=${januaryA}${query}`
    )
    expect(response.status).toBe(OK)
    return response.body as BookBody
  }
  const csv = async (kind: LegalBookKind): Promise<string> => {
    const response = await asAdminA().get(
      `${ApiRoutes.finance.books.csvByKind(kind)}?periodId=${januaryA}`
    )
    expect(response.status).toBe(OK)
    return response.text
  }

  // A sale of 1999 with the tax the order kept (prices include it: 230 of tax, 1769 of base), its sale entry of the day, and a fiscal
  // document of the type when there is one
  async function sale(
    entryDate: string,
    documentType: string | null,
    external: string | null
  ): Promise<string> {
    const order = await createOrder(owner, { storeId: ctx.storeA.id })
    await owner.order.update({
      where: { id: order.id },
      data: { taxCents: 230, pricesIncludeTax: true }
    })
    await owner.orderItem.update({
      where: { id: order.itemId },
      data: { taxTreatment: 'taxed', taxRateBps: 1300, taxCents: 230 }
    })
    const entry = await postTestEntry(owner, {
      organizationId: ctx.orgA.id,
      periodId: januaryA,
      entryDate,
      type: JournalEntryType.SALE,
      sourceType: FinanceSourceType.ORDER,
      sourceId: order.id,
      idempotencyKey: FinancePostingKey.ORDER_SALE(order.id),
      lines: [
        { accountId: accountsA[CASH] ?? '', debitCents: 1999 },
        { accountId: accountsA[SALES] ?? '', creditCents: 1999 }
      ]
    })
    if (documentType !== null) {
      await owner.fiscalDocument.create({
        data: {
          organizationId: ctx.orgA.id,
          storeId: ctx.storeA.id,
          orderId: order.id,
          journalEntryId: entry.id,
          sequenceNumber: (sequence += 1),
          documentType,
          status: 'accepted',
          providerId: 'simulator',
          environment: 'sandbox',
          externalNumber: external,
          issuerSnapshot: {},
          linesSnapshot: { lines: [] },
          receiverEncrypted: Buffer.from('suite'),
          totalCents: 1999,
          taxCents: 230,
          issuedAt: new Date(`${entryDate}T12:00:00Z`)
        }
      })
    }
    return order.id
  }

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    for (const agent of [asAdminA, asAdminB]) {
      const response = await agent()
        .post(ApiRoutes.finance.setup)
        .send({ countryCode: FinanceCountryCodes.EL_SALVADOR, accountingStartDate: START })
      expect(response.status).toBe(201)
    }
    const rows = await owner.ledgerAccount.findMany({
      where: { organizationId: ctx.orgA.id },
      select: { id: true, code: true }
    })
    accountsA = Object.fromEntries(rows.map(row => [row.code, row.id]))
    // The month may exist already (the setup or a posting makes it); the builder makes it when it does not
    const existing = await owner.fiscalPeriod.findFirst({
      where: { organizationId: ctx.orgA.id, year: 2026, month: 1 },
      select: { id: true }
    })
    januaryA = existing?.id ?? (await createPeriod(owner, ctx.orgA.id, 2026, 1))
    // Two purchases in January with a supplier, one of them with no creditable tax
    supplierId = (
      await owner.supplier.create({
        data: { organizationId: ctx.orgA.id, name: 'Proveedor del suite', taxId: 'S-1234' },
        select: { id: true }
      })
    ).id
    const warehouse = await createWarehouse(owner, { organizationId: ctx.orgA.id })
    for (const [index, spec] of [
      { day: '2026-01-05', document: 'F-001', subtotal: 1000, tax: 130, creditable: true },
      { day: '2026-01-20', document: null, subtotal: 400, tax: 0, creditable: false }
    ].entries()) {
      const orderId = randomUUID()
      await owner.purchaseOrder.create({
        data: {
          id: orderId,
          organizationId: ctx.orgA.id,
          number: `PB-${prefix.slice(-6)}-${String(index)}`,
          supplierId,
          warehouseId: warehouse.id,
          status: PurchaseOrderStatus.DRAFT,
          clientKey: `books-${orderId}`,
          createdBy: 'books-suite'
        }
      })
      const receiptId = randomUUID()
      const entry = await postTestEntry(owner, {
        organizationId: ctx.orgA.id,
        periodId: januaryA,
        entryDate: spec.day,
        type: JournalEntryType.PURCHASE_RECEIPT,
        sourceType: FinanceSourceType.PURCHASE_RECEIPT,
        sourceId: receiptId,
        lines: [
          { accountId: accountsA[INVENTORY] ?? '', debitCents: spec.subtotal + spec.tax },
          { accountId: accountsA[PAYABLE] ?? '', creditCents: spec.subtotal + spec.tax }
        ]
      })
      await owner.purchaseReceipt.create({
        data: {
          id: receiptId,
          organizationId: ctx.orgA.id,
          purchaseOrderId: orderId,
          supplierId,
          receivedOn: new Date(`${spec.day}T00:00:00Z`),
          dueOn: new Date(`${spec.day}T00:00:00Z`),
          supplierDocumentNumber: spec.document,
          taxCreditable: spec.creditable,
          subtotalCents: spec.subtotal,
          taxCents: spec.tax,
          totalCents: spec.subtotal + spec.tax,
          clientKey: `books-${receiptId}`,
          entryId: entry.id,
          createdBy: 'books-suite'
        }
      })
    }
    orders.taxpayer = await sale('2026-01-10', SimulatorDocumentTypes.BUSINESS, 'CCF-1')
    orders.consumer = await sale('2026-01-11', SimulatorDocumentTypes.CONSUMER, 'FAC-1')
    orders.unissued = await sale('2026-01-12', null, null)
  })

  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  describe('the layouts', () => {
    it('start as the proposal, which says nobody validated it', async () => {
      const response = await asAdminA().get(ApiRoutes.finance.bookLayouts.list)

      expect(response.status).toBe(OK)
      const layouts = response.body as LayoutBody[]
      expect(layouts.map(layout => layout.kind).sort()).toEqual(Object.values(LegalBookKind).sort())
      for (const layout of layouts) {
        expect(layout.version).toBe(0)
        expect(layout.source).toBe('proposal')
        expect(layout.accountantConfirmed).toBe(false)
      }
    })

    it('refuse a column of another kind of book, and one that names a customer', async () => {
      const columns = [{ field: LegalBookField.SUPPLIER_TAX_ID, label: null }]
      const wrongKind = await asAdminA()
        .put(ApiRoutes.finance.bookLayouts.byKind(LegalBookKind.SALES_CONSUMERS))
        .send(layoutBody(columns))
      const unknown = await asAdminA()
        .put(ApiRoutes.finance.bookLayouts.byKind(LegalBookKind.SALES_CONSUMERS))
        .send(layoutBody([{ field: 'customer_name', label: null }]))

      expect(wrongKind.status).toBe(BAD_REQUEST)
      expect(unknown.status).toBe(BAD_REQUEST)
    })

    it('are written as a new version and never changed in place', async () => {
      const first = await asAdminA()
        .put(ApiRoutes.finance.bookLayouts.byKind(LegalBookKind.PURCHASES))
        .send(
          layoutBody([
            { field: LegalBookField.CORRELATIVE, label: 'Correlativo' },
            { field: LegalBookField.DOCUMENT_NUMBER, label: null },
            { field: LegalBookField.SUPPLIER_NAME, label: null },
            { field: LegalBookField.TOTAL, label: null }
          ])
        )
      const second = await asAdminA()
        .put(ApiRoutes.finance.bookLayouts.byKind(LegalBookKind.PURCHASES))
        .send(layoutBody([{ field: LegalBookField.TOTAL, label: 'Total' }], 500, true))

      expect((first.body as LayoutBody).version).toBe(1)
      expect((second.body as LayoutBody).version).toBe(2)
      expect((second.body as LayoutBody).accountantConfirmed).toBe(true)
      await expect(
        owner.financeBookLayout.updateMany({
          where: { organizationId: ctx.orgA.id },
          data: { sort: 'document' }
        })
      ).rejects.toThrow(/never changed or deleted/)
      await expect(
        owner.financeBookLayout.deleteMany({ where: { organizationId: ctx.orgA.id } })
      ).rejects.toThrow(/never changed or deleted/)
      const audit = await waitForAuditEntries(owner, {
        organizationId: ctx.orgA.id,
        action: AuditAction.FINANCE_BOOK_LAYOUT_CHANGED
      })
      expect(audit.length).toBeGreaterThanOrEqual(2)
    })

    it('need the permission of the settings to be written and one to be read', async () => {
      const reader = await asRole('books-reader', [Permissions.FINANCE_VIEW_REPORTS])
      const viewer = await asRole('books-viewer', [Permissions.FINANCE_VIEW])

      const write = await reader
        .put(ApiRoutes.finance.bookLayouts.byKind(LegalBookKind.PURCHASES))
        .send(layoutBody([{ field: LegalBookField.TOTAL, label: null }]))
      const read = await reader.get(ApiRoutes.finance.bookLayouts.list)
      const without = await viewer.get(ApiRoutes.finance.bookLayouts.list)

      expect(write.status).toBe(FORBIDDEN)
      expect(read.status).toBe(OK)
      expect(without.status).toBe(FORBIDDEN)
    })
  })

  describe('the purchases book', () => {
    it('lists a row per receipt of the period with the numbers of the proposal, and says it is a draft', async () => {
      const body = await book(LegalBookKind.PURCHASES, '&layoutVersion=0')

      expect(body.unvalidated).toBe(true)
      expect(body.layout).toMatchObject({ version: 0, source: 'proposal' })
      expect(body.frozen).toBe(false)
      expect(body.header).toContain('supplier_name')
      expect(body.rows).toHaveLength(2)
      const total = body.header.indexOf('total')
      const tax = body.header.indexOf('tax')
      expect(body.rows.map(row => row[total])).toEqual([1130, 400])
      expect(body.totals[LegalBookField.TAX]).toBe(130)
      expect(body.rows[0]?.[body.header.indexOf('correlative')]).toBe(1)
      expect(body.rows[1]?.[body.header.indexOf('correlative')]).toBe(2)
      expect(body.rows[0]?.[tax]).toBe(130)
      expect(body.rows[0]?.[body.header.indexOf('supplier_name')]).toBe('Proveedor del suite')
    })

    it('follows the layout of the organization when no version is named, and the proposal when version 0 is', async () => {
      const latest = await book(LegalBookKind.PURCHASES)
      const proposal = await book(LegalBookKind.PURCHASES, '&layoutVersion=0')

      expect(latest.layout.version).toBe(2)
      expect(latest.unvalidated).toBe(false)
      expect(latest.header).toEqual(['Total'])
      expect(proposal.header.length).toBeGreaterThan(latest.header.length)
    })

    it('refuses a version of the layout that was never written', async () => {
      const response = await asAdminA().get(
        `${ApiRoutes.finance.books.byKind(LegalBookKind.PURCHASES)}?periodId=${januaryA}&layoutVersion=99`
      )

      expect(response.status).toBe(NOT_FOUND)
    })
  })

  describe('the sales books', () => {
    it('put a sale to a buyer with a tax identity in the taxpayers book, the rest in the consumers book', async () => {
      const taxpayers = await book(LegalBookKind.SALES_TAXPAYERS)
      const consumers = await book(LegalBookKind.SALES_CONSUMERS)

      expect(taxpayers.rows).toHaveLength(1)
      expect(consumers.rows).toHaveLength(2)
      const document = taxpayers.header.indexOf('document_number')
      expect(taxpayers.rows[0]?.[document]).toBe('CCF-1')
      expect(consumers.rows.map(row => row[consumers.header.indexOf('document_number')])).toEqual([
        'FAC-1',
        null
      ])
      expect(taxpayers.totals[LegalBookField.TOTAL]).toBe(1999)
      expect(taxpayers.totals[LegalBookField.TAX]).toBe(230)
      expect(taxpayers.totals[LegalBookField.BASE_TAXED]).toBe(1769)
      expect(consumers.totals[LegalBookField.TOTAL]).toBe(3998)
    })

    it('leave a sale with no document out of both books when the layout says so', async () => {
      const columns = [
        { field: LegalBookField.CORRELATIVE, label: null },
        { field: LegalBookField.DOCUMENT_NUMBER, label: null },
        { field: LegalBookField.TOTAL, label: null }
      ]
      const response = await asAdminA()
        .put(ApiRoutes.finance.bookLayouts.byKind(LegalBookKind.SALES_CONSUMERS))
        .send({ ...layoutBody(columns), unissuedSales: 'excluded' })
      expect(response.status).toBe(OK)

      const consumers = await book(LegalBookKind.SALES_CONSUMERS)

      expect(consumers.rows).toEqual([[1, 'FAC-1', 1999]])
    })

    it('carry no customer data in a file', async () => {
      const text = await csv(LegalBookKind.SALES_TAXPAYERS)

      expect(text).not.toMatch(/suite|@|customer/i)
      expect(text).toContain('CCF-1')
    })
  })

  describe('the files', () => {
    it('are a CSV with the state of the book beside them, and leave an audit row', async () => {
      const response = await asAdminA().get(
        `${ApiRoutes.finance.books.csvByKind(LegalBookKind.PURCHASES)}?periodId=${januaryA}&layoutVersion=0`
      )

      expect(response.status).toBe(OK)
      expect(response.headers['content-type']).toContain('text/csv')
      expect(response.headers['cache-control']).toBe('no-store')
      expect(response.headers['x-book-unvalidated']).toBe('true')
      expect(response.headers['x-book-sha256']).toMatch(/^[0-9a-f]{64}$/)
      const audit = await waitForAuditEntries(owner, {
        organizationId: ctx.orgA.id,
        action: AuditAction.FINANCE_EXPORTED
      })
      expect(audit.map(row => (row.metadata as { report?: string } | null)?.report)).toContain(
        `book_${LegalBookKind.PURCHASES}`
      )
    })

    it('need finance:export as well as finance:view_reports', async () => {
      const reader = await asRole('books-file-reader', [Permissions.FINANCE_VIEW_REPORTS])
      const exporter = await asRole('books-file-exporter', [
        Permissions.FINANCE_VIEW_REPORTS,
        Permissions.FINANCE_EXPORT
      ])
      const path = `${ApiRoutes.finance.books.csvByKind(LegalBookKind.PURCHASES)}?periodId=${januaryA}`

      expect((await reader.get(path)).status).toBe(FORBIDDEN)
      expect((await exporter.get(path)).status).toBe(OK)
      // The same rows as JSON are the same data: they ask for the same two permissions
      const json = `${ApiRoutes.finance.books.byKind(LegalBookKind.PURCHASES)}?periodId=${januaryA}`
      expect((await reader.get(json)).status).toBe(FORBIDDEN)
      expect((await exporter.get(json)).status).toBe(OK)
      expect((await reader.get(ApiRoutes.finance.frozenBooks.list)).status).toBe(FORBIDDEN)
    })

    it('are never another organization’s: its period is not found and its layouts are its own', async () => {
      const crossed = await asAdminB().get(
        `${ApiRoutes.finance.books.byKind(LegalBookKind.PURCHASES)}?periodId=${januaryA}`
      )
      const layouts = await asAdminB().get(ApiRoutes.finance.bookLayouts.list)

      expect(crossed.status).toBe(NOT_FOUND)
      expect((layouts.body as LayoutBody[]).every(layout => layout.version === 0)).toBe(true)
    })
  })

  describe('the book of a closed month', () => {
    let before = ''
    let beforeSha = ''

    it('is frozen when it is first asked for after the close, and served from there', async () => {
      const close = await asAdminA().post(ApiRoutes.finance.periods.close(januaryA)).send({})
      expect(close.status).toBe(OK)

      const first = await book(LegalBookKind.PURCHASES)
      before = await csv(LegalBookKind.PURCHASES)
      beforeSha = first.contentSha256

      expect(first.frozen).toBe(true)
      const frozen = await asAdminA().get(ApiRoutes.finance.frozenBooks.list)
      expect(frozen.status).toBe(OK)
      expect(
        (frozen.body as { kind: string; contentSha256: string }[]).some(
          row =>
            (row.kind as LegalBookKind) === LegalBookKind.PURCHASES &&
            row.contentSha256 === beforeSha
        )
      ).toBe(true)
      const audit = await waitForAuditEntries(owner, {
        organizationId: ctx.orgA.id,
        action: AuditAction.FINANCE_BOOK_FROZEN
      })
      expect(audit.length).toBeGreaterThanOrEqual(1)
    })

    it('is the same bytes after the supplier is renamed and after a new layout is written', async () => {
      await owner.supplier.update({
        where: { id: supplierId },
        data: { name: 'Otro nombre', taxId: 'X-9' }
      })
      const written = await asAdminA()
        .put(ApiRoutes.finance.bookLayouts.byKind(LegalBookKind.PURCHASES))
        .send(layoutBody([{ field: LegalBookField.SUPPLIER_NAME, label: null }]))
      expect(written.status).toBe(OK)

      // With the layout it was frozen with, named explicitly
      const again = await asAdminA().get(
        `${ApiRoutes.finance.books.csvByKind(LegalBookKind.PURCHASES)}?periodId=${januaryA}&layoutVersion=2`
      )

      expect(again.status).toBe(OK)
      expect(again.text).toBe(before)
      expect(again.headers['x-book-sha256']).toBe(beforeSha)
      expect(again.text).not.toContain('Otro nombre')
      // The default book of the month is the one frozen first, not the layout written since
      const byDefault = await asAdminA().get(
        `${ApiRoutes.finance.books.csvByKind(LegalBookKind.PURCHASES)}?periodId=${januaryA}`
      )
      expect(byDefault.text).toBe(before)
      // Asking for the proposal does not decide what the month's book is, and is not kept
      const proposal = await asAdminA().get(
        `${ApiRoutes.finance.books.byKind(LegalBookKind.PURCHASES)}?periodId=${januaryA}&layoutVersion=0`
      )
      expect((proposal.body as BookBody).frozen).toBe(false)
      expect(
        await owner.financeBookSnapshot.count({
          where: {
            organizationId: ctx.orgA.id,
            bookKind: LegalBookKind.PURCHASES,
            layoutVersion: 0
          }
        })
      ).toBe(0)
    })

    it('can be read again from the list of the frozen books, and only by its own organization', async () => {
      const list = (await asAdminA().get(ApiRoutes.finance.frozenBooks.list)).body as {
        id: string
        contentSha256: string
      }[]
      const mine = list.find(row => row.contentSha256 === beforeSha)
      expect(mine).toBeDefined()

      const own = await asAdminA().get(ApiRoutes.finance.frozenBooks.byId(mine?.id ?? ''))
      const other = await asAdminB().get(ApiRoutes.finance.frozenBooks.byId(mine?.id ?? ''))

      expect(own.status).toBe(OK)
      expect((own.body as BookBody).contentSha256).toBe(beforeSha)
      expect(other.status).toBe(NOT_FOUND)
      expect((await asAdminB().get(ApiRoutes.finance.frozenBooks.list)).body).toEqual([])
    })

    it('is never changed or deleted in the database', async () => {
      await expect(
        owner.financeBookSnapshot.updateMany({
          where: { organizationId: ctx.orgA.id },
          data: { contentSha256: 'a'.repeat(64) }
        })
      ).rejects.toThrow(/never changed or deleted/)
      await expect(
        owner.financeBookSnapshot.deleteMany({ where: { organizationId: ctx.orgA.id } })
      ).rejects.toThrow(/never changed or deleted/)
    })
  })

  describe('the confirmation of a layout (FIS-426)', () => {
    it('takes finance:confirm_books, for confirming and for writing over a confirmed layout', async () => {
      const manager = await asRole('books-manager', [
        Permissions.FINANCE_MANAGE_ACCOUNTS,
        Permissions.FINANCE_VIEW_REPORTS
      ])
      const confirmer = await asRole('books-confirmer', [
        Permissions.FINANCE_MANAGE_ACCOUNTS,
        Permissions.FINANCE_CONFIRM_BOOKS
      ])
      const onlyConfirm = await asRole('books-only-confirm', [Permissions.FINANCE_CONFIRM_BOOKS])
      const columns = [{ field: LegalBookField.TOTAL, label: null }]
      const route = ApiRoutes.finance.bookLayouts.byKind(LegalBookKind.PURCHASES)
      const put = (who: typeof manager, confirmed: boolean) =>
        who.put(route).send(layoutBody(columns, 1, confirmed))
      const latest = async (): Promise<LayoutBody> => {
        const list = await asAdminA().get(ApiRoutes.finance.bookLayouts.list)
        return (list.body as LayoutBody[]).find(
          item => String(item.kind) === String(LegalBookKind.PURCHASES)
        ) as LayoutBody
      }

      // Whoever manages the settings writes a layout, never a confirmed one
      expect((await put(manager, true)).status).toBe(FORBIDDEN)
      expect((await put(manager, false)).status).toBe(OK)
      expect((await latest()).accountantConfirmed).toBe(false)
      // The permission to confirm alone does not write: the route asks for the settings too
      expect((await put(onlyConfirm, true)).status).toBe(FORBIDDEN)
      // The Admin preset holds both, and so does a role with the two
      expect((await put(confirmer, true)).status).toBe(OK)
      const confirmed = await latest()
      expect(confirmed.accountantConfirmed).toBe(true)
      // A confirmed layout is not written over by a person who cannot confirm: the new version would drop the accountant's word
      expect((await put(manager, false)).status).toBe(FORBIDDEN)
      expect((await latest()).version).toBe(confirmed.version)
      expect(
        (
          await asAdminA()
            .put(route)
            .send(layoutBody(columns, 1, true))
        ).status
      ).toBe(OK)
    })
  })
})

function layoutBody(
  columns: { field: string; label: string | null }[],
  correlativeStart = 1,
  accountantConfirmed = false
): Record<string, unknown> {
  return {
    columns,
    sort: 'date',
    correlativeStart,
    correlativeRestart: 'month',
    unissuedSales: 'consumers',
    accountantConfirmed
  }
}
