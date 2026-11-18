import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  AccountRole,
  FinanceCountryCodes,
  FinanceEventKind,
  FinanceReport,
  FinanceSourceType,
  InventoryMovementType,
  JournalEntryType,
  MarginWarning
} from '@platform/core/domain'
import { FinancePostingService } from '@platform/core/finance-ledger'

import { createCarrierConnection, createOrder } from '../builders'
import { postTestEntry } from '../builders/finance'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

interface MarginBody {
  from: string
  to: string
  storeId: string | null
  rows: {
    storeId: string
    productId: string
    productName: string | null
    unitsSold: number
    revenueCents: number
    costCents: number
    marginCents: number
    marginBps: number | null
  }[]
  totals: { unitsSold: number; revenueCents: number; costCents: number; marginCents: number }
  ledger: {
    revenueCents: number | null
    costCents: number | null
    revenueDifferenceCents: number | null
    costDifferenceCents: number | null
  }
  returns: { revenueCents: number | null; costCents: number | null }
  ordersUsed: number
  ordersNotReadable: number
  unvaluedUnits: number
  warnings: string[]
}

const OK = 200
const CREATED = 201
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404

const TODAY = new Date().toISOString().slice(0, 10)
const NOON = (day: string): Date => new Date(`${day}T18:00:00Z`)

// The margin by product (TDD_18 §10, Step 4B.8b-2): what each order recorded less what its stock cost, compared with the ledger.
describe('The margin by product', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let posting: FinancePostingService
  const orderA: string[] = []
  let orderB = ''

  const asAdminA = () => api(app, ctx.adminA, ctx.storeA)
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
  const range = `from=${TODAY}&to=${TODAY}`

  // A delivered order of 2 x $11.30 with the tax in the price (net $20.00), paid on delivery, with what left for it at $4.00 a unit
  async function deliveredOrder(storeId: string, warehouseId: string): Promise<string> {
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
        status: 'DELIVERED',
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
    await owner.inventoryMovement.create({
      data: {
        storeId,
        productId: item.productId,
        warehouseId,
        type: InventoryMovementType.ISSUE,
        quantity: 2,
        referenceType: 'order',
        referenceId: made.id,
        idempotencyKey: `issue-${randomUUID()}`,
        unitCostCents: 400,
        onHandAfter: 0,
        reservedAfter: 0
      }
    })
    return made.id
  }

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    posting = app.get(FinancePostingService)
    for (const [user, store] of [
      [ctx.adminA, ctx.storeA],
      [ctx.adminB, ctx.storeB]
    ] as const) {
      const setup = await api(app, user, store)
        .post(ApiRoutes.finance.setup)
        .send({ countryCode: FinanceCountryCodes.EL_SALVADOR, accountingStartDate: '2020-01-01' })
      expect(setup.status).toBe(CREATED)
    }
    for (let index = 0; index < 2; index += 1) {
      const id = await deliveredOrder(ctx.storeA.id, ctx.warehouseA.id)
      orderA.push(id)
      await posting.post({
        organizationId: ctx.orgA.id,
        sourceType: FinanceSourceType.ORDER,
        sourceId: id,
        kind: FinanceEventKind.SALE
      })
    }
    orderB = await deliveredOrder(ctx.storeB.id, ctx.warehouseB.id)
    await posting.post({
      organizationId: ctx.orgB.id,
      sourceType: FinanceSourceType.ORDER,
      sourceId: orderB,
      kind: FinanceEventKind.SALE
    })
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const margin = async (query = range, agent = asAdminA()) =>
    agent.get(`${ApiRoutes.finance.reports.margin}?${query}`)

  it('gives the margin of each product and reconciles the totals with the ledger to the cent', async () => {
    const response = await margin()
    const body = response.body as MarginBody

    expect(response.status).toBe(OK)
    expect(body.rows).toHaveLength(2)
    for (const row of body.rows) {
      expect(row).toMatchObject({
        unitsSold: 2,
        revenueCents: 2000,
        costCents: 800,
        marginCents: 1200,
        marginBps: 6000
      })
      expect(row.productName).not.toBeNull()
    }
    expect(body.totals).toMatchObject({
      unitsSold: 4,
      revenueCents: 4000,
      costCents: 1600,
      marginCents: 2400
    })
    // The ledger holds the same revenue and cost for the same sale entries, so nothing is left over
    expect(body.ledger).toEqual({
      revenueCents: 4000,
      costCents: 1600,
      revenueDifferenceCents: 0,
      costDifferenceCents: 0
    })
    expect(body.returns).toEqual({ revenueCents: 0, costCents: 0 })
    expect(body.ordersUsed).toBe(2)
    expect(body.warnings).toEqual([])
  })

  it('never shows the products of another organization, and refuses its store', async () => {
    const body = (await margin()).body as MarginBody
    const productsOfB = await owner.orderItem.findMany({
      where: { orderId: orderB },
      select: { productId: true }
    })
    expect(body.rows.map(row => row.productId)).not.toContain(productsOfB[0]?.productId)
    expect(body.rows.every(row => row.storeId === ctx.storeA.id)).toBe(true)

    const foreign = await margin(`${range}&storeId=${ctx.storeB.id}`)
    expect(foreign.status).toBe(NOT_FOUND)
    const foreignFile = await asAdminA().get(
      `${ApiRoutes.finance.reports.marginCsv}?${range}&storeId=${ctx.storeB.id}`
    )
    expect(foreignFile.status).toBe(NOT_FOUND)
  })

  it('narrows to a store and compares that store with the ledger lines of the same store', async () => {
    const body = (await margin(`${range}&storeId=${ctx.storeA.id}`)).body as MarginBody
    expect(body.storeId).toBe(ctx.storeA.id)
    expect(body.totals.revenueCents).toBe(4000)
    expect(body.ledger.revenueDifferenceCents).toBe(0)
  })

  it('counts a unit that left with no cost apart and shows the difference instead of hiding it', async () => {
    const id = orderA[0] as string
    await owner.inventoryMovement.updateMany({
      where: { referenceId: id, type: InventoryMovementType.ISSUE },
      data: { unitCostCents: null }
    })
    const body = (await margin()).body as MarginBody
    await owner.inventoryMovement.updateMany({
      where: { referenceId: id, type: InventoryMovementType.ISSUE },
      data: { unitCostCents: 400 }
    })

    expect(body.unvaluedUnits).toBe(2)
    expect(body.warnings).toContain(MarginWarning.UNVALUED_UNITS)
    // The cost left out is the difference with the ledger, in the open
    expect(body.ledger.costDifferenceCents).toBe(-800)
    expect(body.ledger.revenueDifferenceCents).toBe(0)
  })

  it('says a role is not mapped instead of comparing against zero', async () => {
    const mapping = await owner.accountRoleMapping.findFirstOrThrow({
      where: { organizationId: ctx.orgB.id, role: AccountRole.COST_OF_GOODS_SOLD }
    })
    await owner.accountRoleMapping.delete({
      where: { organizationId_role: { organizationId: ctx.orgB.id, role: mapping.role } }
    })
    try {
      const response = await margin(range, api(app, ctx.adminB, ctx.storeB))
      const body = response.body as MarginBody
      expect(body.warnings).toContain(MarginWarning.COST_ROLE_NOT_MAPPED)
      expect(body.ledger.costCents).toBeNull()
      expect(body.ledger.costDifferenceCents).toBeNull()
      expect(body.ledger.revenueDifferenceCents).toBe(0)
    } finally {
      await owner.accountRoleMapping.create({ data: mapping })
    }
  })

  it('refuses a range that ends before it starts, and what the schema does not know', async () => {
    expect((await margin(`from=${TODAY}&to=2000-01-01`)).status).toBe(BAD_REQUEST)
    expect((await margin(`${range}&organizationId=${ctx.orgB.id}`)).status).toBe(BAD_REQUEST)
    // A range of more than a year is a request for the whole history in one call
    expect((await margin('from=2020-01-01&to=2026-01-01')).status).toBe(BAD_REQUEST)
  })

  it('needs finance:view_reports to read, and finance:export besides to take the file', async () => {
    const reader = await asRole('margin-reader', [Permissions.FINANCE_VIEW_REPORTS])
    const exporter = await asRole('margin-exporter', [
      Permissions.FINANCE_VIEW_REPORTS,
      Permissions.FINANCE_EXPORT
    ])
    const plain = await asRole('margin-plain', [Permissions.FINANCE_VIEW])

    expect((await margin(range, reader)).status).toBe(OK)
    expect((await reader.get(`${ApiRoutes.finance.reports.marginCsv}?${range}`)).status).toBe(
      FORBIDDEN
    )
    expect((await exporter.get(`${ApiRoutes.finance.reports.marginCsv}?${range}`)).status).toBe(OK)
    expect((await margin(range, plain)).status).toBe(FORBIDDEN)
  })

  it('writes a CSV with no formula in a cell, and leaves an audit row with the range and the count', async () => {
    const id = orderA[1] as string
    const item = await owner.orderItem.findFirstOrThrow({
      where: { orderId: id },
      select: { productId: true }
    })
    await owner.product.update({ where: { id: item.productId }, data: { name: '=HYPERLINK("x")' } })

    const response = await asAdminA().get(`${ApiRoutes.finance.reports.marginCsv}?${range}`)

    expect(response.status).toBe(OK)
    expect(response.headers['content-type']).toContain('text/csv')
    expect(response.headers['cache-control']).toBe('no-store')
    const text = response.text.replace('﻿', '')
    const lines = text.trim().split('\r\n')
    expect(lines[0]).toBe(
      'section,store_id,product_id,name,units_sold,revenue_cents,cost_cents,margin_cents,margin_bps'
    )
    expect(text).not.toMatch(/(^|,)=HYPERLINK/m)
    expect(lines.filter(line => line.startsWith('product,'))).toHaveLength(2)
    expect(lines.some(line => line.startsWith('total,'))).toBe(true)
    expect(lines.some(line => line.startsWith('ledger,'))).toBe(true)
    const audit = await waitForAuditEntries(owner, {
      organizationId: ctx.orgA.id,
      action: AuditAction.FINANCE_EXPORTED
    })
    const mine = audit.find(
      row => (row.metadata as { report?: string } | null)?.report === FinanceReport.MARGIN
    )
    expect(mine?.metadata).toMatchObject({ report: FinanceReport.MARGIN, from: TODAY, to: TODAY })
  })
  // HC-005: the advance payment of an order (E1) is a SALE entry of source ORDER too, under another key than the sale. The margin reads
  // the entry of the sale only (`order:<id>:sale`), as the books do: an order paid in advance is neither counted twice nor in the month
  // of the payment.
  it('does not count the entry of an advance payment as the sale of its order', async () => {
    const before = (await margin()).body as MarginBody
    const advanceOf = await deliveredOrder(ctx.storeA.id, ctx.warehouseA.id)
    const role = async (name: string): Promise<string> =>
      (
        await owner.accountRoleMapping.findUniqueOrThrow({
          where: { organizationId_role: { organizationId: ctx.orgA.id, role: name } }
        })
      ).accountId
    const period = await owner.fiscalPeriod.findFirstOrThrow({
      where: {
        organizationId: ctx.orgA.id,
        startsOn: { lte: new Date(TODAY) },
        endsOn: { gte: new Date(TODAY) }
      }
    })
    await postTestEntry(owner, {
      organizationId: ctx.orgA.id,
      periodId: period.id,
      entryDate: TODAY,
      type: JournalEntryType.SALE,
      sourceType: FinanceSourceType.ORDER,
      sourceId: advanceOf,
      idempotencyKey: `order:${advanceOf}:advance`,
      lines: [
        { accountId: await role('cash_default'), debitCents: 2825 },
        { accountId: await role('customer_advances'), creditCents: 2825 }
      ]
    })
    const after = (await margin()).body as MarginBody

    expect(after.ordersUsed).toBe(before.ordersUsed)
    expect(after.totals).toEqual(before.totals)
    expect(after.ordersUsed).toBe(2)
  })
})

// The VAT file of the period (TDD_18 §7, §10) goes through the audited path of every other file
describe('The VAT file', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    const setup = await api(app, ctx.adminA, ctx.storeA)
      .post(ApiRoutes.finance.setup)
      .send({ countryCode: FinanceCountryCodes.EL_SALVADOR, accountingStartDate: '2020-01-01' })
    expect(setup.status).toBe(CREATED)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  it('needs finance:export besides finance:view to take it out, and leaves an audit row', async () => {
    const viewer = api(
      app,
      await actorWithPermissions(owner, app, {
        prefix,
        name: 'vat-viewer',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.FINANCE_VIEW]
      }),
      ctx.storeA
    )
    const url = `${ApiRoutes.finance.reports.vatCsv}?from=2026-03-01&to=2026-03-31`

    expect((await viewer.get(url)).status).toBe(FORBIDDEN)
    expect(
      (await viewer.get(`${ApiRoutes.finance.reports.vat}?from=2026-03-01&to=2026-03-31`)).status
    ).toBe(OK)
    const file = await api(app, ctx.adminA, ctx.storeA).get(url)
    expect(file.status).toBe(OK)
    expect(file.headers['cache-control']).toBe('no-store')
    const audit = await waitForAuditEntries(owner, {
      organizationId: ctx.orgA.id,
      action: AuditAction.FINANCE_EXPORTED
    })
    expect(
      audit.find(row => (row.metadata as { report?: string } | null)?.report === FinanceReport.VAT)
        ?.metadata
    ).toMatchObject({ report: FinanceReport.VAT, from: '2026-03-01', to: '2026-03-31' })
  })

  it('leaves no audit row for a file it refused', async () => {
    const before = await owner.auditLog.count({
      where: { organizationId: ctx.orgA.id, action: AuditAction.FINANCE_EXPORTED }
    })
    const refused = await api(app, ctx.adminA, ctx.storeA).get(
      `${ApiRoutes.finance.reports.vatCsv}?from=2026-03-31&to=2026-03-01`
    )
    expect(refused.status).toBe(BAD_REQUEST)
    expect(
      await owner.auditLog.count({
        where: { organizationId: ctx.orgA.id, action: AuditAction.FINANCE_EXPORTED }
      })
    ).toBe(before)
  })
})
