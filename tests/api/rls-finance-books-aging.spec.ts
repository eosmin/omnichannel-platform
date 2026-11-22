import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { PrismaService, RLS_CONTEXT_ENABLED } from '@platform/core/database'
import { connectionUrls, type OwnerClient } from '@platform/core/database-testing'
import {
  AgingKind,
  FinanceCountryCodes,
  FinancePostingKey,
  FinanceSourceType,
  JournalEntryType,
  LegalBookField,
  LegalBookKind,
  PartyType,
  PurchaseOrderStatus
} from '@platform/core/domain'
import { SimulatorDocumentTypes } from '@platform/fiscal/simulator'

import { createPeriod, postTestEntry } from '../builders/finance'
import { createOrder } from '../builders/order'
import { createWarehouse } from '../builders/warehouse'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const CREATED = 201
const START = '2026-01-01'
const CASH = '1101'
const SALES = '4101'
const INVENTORY = '1301'
const PAYABLE = '2101'

interface BookBody {
  rows: (string | number | boolean | null)[][]
  totals: Record<string, number>
  contentSha256: string
}
interface AgingBody {
  rows: { partyName: string | null; totalCents: string }[]
  totalCents: string
  missingRoles: string[]
}

// Debt (g) of the limits of PR 7.3-D: the legal books, the margin with sales and the aging with parties had no case of their own with row
// security ENFORCED (the margin has one since 7.3-E, `rls-finance-margin-report.spec.ts`). The reports read in short units of the
// organization, one per page, and the books and the aging read journal lines, fiscal documents, purchase receipts and suppliers: a read
// that kept the client of the request instead of the one of the unit would read nothing, or the lines of one store, under enforcement.
// Everything is posted through the owner client; the reads go through the real app on the role of the api, with the switch on and a context
// required for every query, and each answer is compared with the same read through an app that is not guarded.
describe('RLS phase 6: the books and the aging read the whole organization under enforcement', () => {
  const prefix = newRunPrefix()
  let setupApp: INestApplication | undefined
  let app: INestApplication | undefined
  let guarded: PrismaService | undefined
  let owner: OwnerClient
  let ctx: TestContext
  let accounts: Record<string, string> = {}
  let januaryId = ''
  let supplierId = ''
  let sequence = 5000

  // A sale of 1999 (230 of tax in the price) in one store, with its entry of the day and an accepted fiscal document of the type
  async function sale(storeId: string, documentType: string, external: string): Promise<void> {
    const order = await createOrder(owner, { storeId })
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
      periodId: januaryId,
      entryDate: '2026-01-10',
      type: JournalEntryType.SALE,
      sourceType: FinanceSourceType.ORDER,
      sourceId: order.id,
      idempotencyKey: FinancePostingKey.ORDER_SALE(order.id),
      lines: [
        { accountId: accounts[CASH] ?? '', debitCents: 1999 },
        { accountId: accounts[SALES] ?? '', creditCents: 1999 }
      ]
    })
    await owner.fiscalDocument.create({
      data: {
        organizationId: ctx.orgA.id,
        storeId,
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
        issuedAt: new Date('2026-01-10T12:00:00Z')
      }
    })
  }

  beforeAll(async () => {
    owner = ownerClient()
    // The books are set up by an app with the switch on but no guard: with row security enforced the role of the api reads and writes only
    // inside a context
    setupApp = await createTestApp([], builder =>
      builder.overrideProvider(RLS_CONTEXT_ENABLED).useValue(true)
    )
    ctx = await seedTestContext(owner, setupApp, prefix)
    const setup = await api(setupApp, ctx.adminA, ctx.storeA)
      .post(ApiRoutes.finance.setup)
      .send({ countryCode: FinanceCountryCodes.EL_SALVADOR, accountingStartDate: START })
    expect(setup.status).toBe(CREATED)
    const rows = await owner.ledgerAccount.findMany({
      where: { organizationId: ctx.orgA.id },
      select: { id: true, code: true }
    })
    accounts = Object.fromEntries(rows.map(row => [row.code, row.id]))
    const existing = await owner.fiscalPeriod.findFirst({
      where: { organizationId: ctx.orgA.id, year: 2026, month: 1 },
      select: { id: true }
    })
    januaryId = existing?.id ?? (await createPeriod(owner, ctx.orgA.id, 2026, 1))
    supplierId = (
      await owner.supplier.create({
        data: { organizationId: ctx.orgA.id, name: 'Proveedor del suite', taxId: 'S-1234' },
        select: { id: true }
      })
    ).id
    // One purchase on credit with the supplier: its receipt (the purchases book) and its payable line with the party (the aging)
    const warehouse = await createWarehouse(owner, { organizationId: ctx.orgA.id })
    const purchaseId = randomUUID()
    await owner.purchaseOrder.create({
      data: {
        id: purchaseId,
        organizationId: ctx.orgA.id,
        number: `PR-${prefix.slice(-6)}`,
        supplierId,
        warehouseId: warehouse.id,
        status: PurchaseOrderStatus.DRAFT,
        clientKey: `rls-books-${purchaseId}`,
        createdBy: 'rls-books-suite'
      }
    })
    const receiptId = randomUUID()
    const receiptEntry = await postTestEntry(owner, {
      organizationId: ctx.orgA.id,
      periodId: januaryId,
      entryDate: '2026-01-05',
      type: JournalEntryType.PURCHASE_RECEIPT,
      sourceType: FinanceSourceType.PURCHASE_RECEIPT,
      sourceId: receiptId,
      lines: [
        { accountId: accounts[INVENTORY] ?? '', debitCents: 1130 },
        {
          accountId: accounts[PAYABLE] ?? '',
          creditCents: 1130,
          partyType: PartyType.SUPPLIER,
          partyId: supplierId
        }
      ]
    })
    await owner.purchaseReceipt.create({
      data: {
        id: receiptId,
        organizationId: ctx.orgA.id,
        purchaseOrderId: purchaseId,
        supplierId,
        receivedOn: new Date('2026-01-05T00:00:00Z'),
        dueOn: new Date('2026-01-05T00:00:00Z'),
        supplierDocumentNumber: 'F-001',
        taxCreditable: true,
        subtotalCents: 1000,
        taxCents: 130,
        totalCents: 1130,
        clientKey: `rls-books-${receiptId}`,
        entryId: receiptEntry.id,
        createdBy: 'rls-books-suite'
      }
    })
    // One sale to a taxpayer in each store of the organization: the book must list both, whichever store the header names
    await sale(ctx.storeA.id, SimulatorDocumentTypes.BUSINESS, 'CCF-A')
    await sale(ctx.storeA2.id, SimulatorDocumentTypes.BUSINESS, 'CCF-A2')

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

  const read = async (
    target: INestApplication | undefined,
    actor: typeof ctx.adminA,
    store: { id: string },
    route: string
  ): Promise<{ status: number; body: unknown; text: string }> => {
    if (target === undefined) throw new Error('the app of the spec did not start')
    const response = await api(target, actor, store).get(route)
    return { status: response.status, body: response.body as unknown, text: response.text }
  }
  const bookRoute = (kind: LegalBookKind): string =>
    `${ApiRoutes.finance.books.byKind(kind)}?periodId=${januaryId}`
  const agingRoute = `${ApiRoutes.finance.reports.aging}?kind=${AgingKind.PAYABLES}&asOf=2026-01-31`

  it('lists the sales of both stores in the taxpayers book, with the header of either store, the same as an unguarded read', async () => {
    const fromA = await read(app, ctx.adminA, ctx.storeA, bookRoute(LegalBookKind.SALES_TAXPAYERS))
    const fromA2 = await read(
      app,
      ctx.adminA2,
      ctx.storeA2,
      bookRoute(LegalBookKind.SALES_TAXPAYERS)
    )
    const plain = await read(
      setupApp,
      ctx.adminA,
      ctx.storeA,
      bookRoute(LegalBookKind.SALES_TAXPAYERS)
    )

    for (const answer of [fromA, fromA2, plain]) expect(answer.status).toBe(OK)
    for (const answer of [fromA, fromA2]) {
      const body = answer.body as BookBody
      expect(body.rows).toHaveLength(2)
      expect(body.totals[LegalBookField.TOTAL]).toBe(3998)
      expect(body.totals[LegalBookField.TAX]).toBe(460)
      expect(body.contentSha256).toBe((plain.body as BookBody).contentSha256)
    }
  })

  it('lists the purchase of the organization in the purchases book with the guarded client', async () => {
    const guardedBook = await read(app, ctx.adminA, ctx.storeA, bookRoute(LegalBookKind.PURCHASES))
    const plain = await read(setupApp, ctx.adminA, ctx.storeA, bookRoute(LegalBookKind.PURCHASES))

    expect(guardedBook.status).toBe(OK)
    const body = guardedBook.body as BookBody
    expect(body.rows).toHaveLength(1)
    expect(body.totals[LegalBookField.TOTAL]).toBe(1130)
    expect(body.contentSha256).toBe((plain.body as BookBody).contentSha256)
  })

  it('writes the same file of the taxpayers book with the header of either store', async () => {
    const csvRoute = `${ApiRoutes.finance.books.csvByKind(LegalBookKind.SALES_TAXPAYERS)}?periodId=${januaryId}`
    const fromA = await read(app, ctx.adminA, ctx.storeA, csvRoute)
    const fromA2 = await read(app, ctx.adminA2, ctx.storeA2, csvRoute)

    expect(fromA.status).toBe(OK)
    expect(fromA2.text).toBe(fromA.text)
    expect(fromA.text).toContain('CCF-A')
    expect(fromA.text).toContain('CCF-A2')
  })

  it('ages the payable of the supplier with the header of either store, the same as an unguarded read', async () => {
    const fromA = await read(app, ctx.adminA, ctx.storeA, agingRoute)
    const fromA2 = await read(app, ctx.adminA2, ctx.storeA2, agingRoute)
    const plain = await read(setupApp, ctx.adminA, ctx.storeA, agingRoute)

    for (const answer of [fromA, fromA2, plain]) expect(answer.status).toBe(OK)
    for (const answer of [fromA, fromA2]) {
      const body = answer.body as AgingBody
      expect(body.missingRoles).toEqual([])
      expect(body.rows.map(row => row.partyName)).toEqual(['Proveedor del suite'])
      expect(body.totalCents).toBe('1130')
    }
    expect(fromA.body).toEqual(plain.body)
  })
})
