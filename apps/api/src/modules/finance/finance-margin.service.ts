import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { PrismaService } from '@platform/core/database'
import {
  AccountRole,
  FinanceReport,
  FinanceReportLimits,
  FinanceResourceTypes,
  FinanceSourceType,
  InventoryMovementType,
  InventoryReferenceType,
  JournalEntryType,
  MarginCsvSection,
  MarginWarning
} from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import {
  addMarginRows,
  marginBps,
  type MarginMovement,
  marginOfOrder,
  type MarginOrder,
  type MarginRow,
  reconcileMargin
} from '@platform/core/finance'

import type { Actor } from '../tenancy'

import type { MarginCsvRow } from './finance-margin.csv'
import type { FlowQuery } from './finance-reports.schemas'
import { centsAsNumber } from './finance.support'

export interface MarginRowView {
  storeId: string
  productId: string
  productName: string | null
  unitsSold: number
  revenueCents: number
  costCents: number
  marginCents: number
  marginBps: number | null
}

export interface MarginView {
  from: string
  to: string
  storeId: string | null
  rows: MarginRowView[]
  totals: {
    unitsSold: number
    revenueCents: number
    costCents: number
    marginCents: number
    marginBps: number | null
  }
  // The figures of the ledger for the same sale entries, and the report less the ledger (zero reconciles). Null when the role is not mapped.
  ledger: {
    revenueCents: number | null
    costCents: number | null
    revenueDifferenceCents: number | null
    costDifferenceCents: number | null
  }
  // What the returns of the same range took back from the revenue and from the cost, as the ledger holds them. The products above are
  // gross of returns: a return is not split by product (debt of the plan)
  returns: { revenueCents: number | null; costCents: number | null }
  ordersUsed: number
  ordersNotReadable: number
  unvaluedUnits: number
  warnings: MarginWarning[]
}

interface LedgerRow {
  type: string
  role: string
  net: bigint
}

// The margin by product and store (TDD_18 §10): the revenue each order recorded, less the cost its stock movements carried, for the sale
// entries of the range (so it follows the date the ledger recognized the sale, not the date of the order). The totals are compared with
// the ledger's revenue and cost of goods and the difference is shown, never forced to zero. A report only reads: it never changes the
// journal, and a role the organization has not mapped is warned, never replaced by a guess. A file taken out leaves an audit row
// (FINANCE_EXPORTED), written the way every finance audit row is (not awaited, debt (k) of 4B.8a).
@Injectable()
export class FinanceMarginService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async margin(organizationId: string, query: FlowQuery): Promise<MarginView> {
    await this.requireStore(organizationId, query.storeId)
    const db = this.prisma.client
    const rows = new Map<string, MarginRow>()
    let orderRevenue = 0
    let orderCost = 0
    let ordersUsed = 0
    let ordersNotReadable = 0
    let unvaluedUnits = 0
    let after = 0n
    for (;;) {
      const entries = await db.journalEntry.findMany({
        where: {
          organizationId,
          type: JournalEntryType.SALE,
          sourceType: FinanceSourceType.ORDER,
          sourceId: { not: null },
          entryDate: { gte: new Date(query.from), lte: new Date(query.to) },
          number: { gt: after }
        },
        select: { number: true, sourceId: true },
        orderBy: { number: 'asc' },
        take: FinanceReportLimits.MARGIN_PAGE_SIZE
      })
      if (entries.length === 0) break
      const ids = [
        ...new Set(entries.flatMap(entry => (entry.sourceId === null ? [] : [entry.sourceId])))
      ]
      const everyOrder = await db.order.findMany({
        // The organization is the store's: an order of another organization is never read, whatever the entry says
        where: { id: { in: ids }, store: { organizationId } },
        select: {
          id: true,
          storeId: true,
          subtotalCents: true,
          shippingCents: true,
          discountCents: true,
          totalCents: true,
          taxCents: true,
          pricesIncludeTax: true,
          items: {
            select: { productId: true, quantity: true, unitPriceCents: true, taxCents: true }
          }
        }
      })
      // An order of another store than the one asked is left out on purpose; one that is not found at all is counted
      const orders =
        query.storeId === undefined
          ? everyOrder
          : everyOrder.filter(order => order.storeId === query.storeId)
      const movements = await db.inventoryMovement.findMany({
        where: {
          type: InventoryMovementType.ISSUE,
          referenceType: InventoryReferenceType.ORDER,
          referenceId: { in: orders.map(order => order.id) },
          storeId: { in: [...new Set(orders.map(order => order.storeId))] }
        },
        select: {
          storeId: true,
          referenceId: true,
          productId: true,
          quantity: true,
          unitCostCents: true
        }
      })
      const movementsOf = new Map<string, MarginMovement[]>()
      for (const movement of movements) {
        const key = `${movement.storeId}:${movement.referenceId}`
        movementsOf.set(key, [...(movementsOf.get(key) ?? []), movement])
      }
      // An entry whose order cannot be found at all is counted, never skipped in silence
      const found = new Set(everyOrder.map(order => order.id))
      ordersNotReadable += ids.filter(id => !found.has(id)).length
      for (const order of orders) {
        const draft: MarginOrder = { ...order, lines: order.items }
        const result = marginOfOrder(draft, movementsOf.get(`${order.storeId}:${order.id}`) ?? [])
        if (!result.ok) {
          ordersNotReadable += 1
          continue
        }
        ordersUsed += 1
        addMarginRows(rows, result.rows)
        orderRevenue += result.revenueCents
        orderCost += result.costCents
        unvaluedUnits += result.unvaluedUnits
      }
      after = entries.at(-1)?.number ?? after
      if (entries.length < FinanceReportLimits.MARGIN_PAGE_SIZE) break
    }

    const ledger = await this.ledgerFigures(organizationId, query)
    const names = await this.namesOf(organizationId, [...rows.values()])
    const views = [...rows.values()]
      .map(row => ({
        storeId: row.storeId,
        productId: row.productId,
        productName: names.get(`${row.storeId}:${row.productId}`) ?? null,
        unitsSold: row.unitsSold,
        revenueCents: row.revenueCents,
        costCents: row.costCents,
        marginCents: row.revenueCents - row.costCents,
        marginBps: marginBps(row.revenueCents, row.costCents)
      }))
      .sort(
        (a, b) =>
          b.marginCents - a.marginCents ||
          a.storeId.localeCompare(b.storeId) ||
          a.productId.localeCompare(b.productId)
      )
    const warnings: MarginWarning[] = []
    if (ledger.revenue === null) warnings.push(MarginWarning.REVENUE_ROLE_NOT_MAPPED)
    if (ledger.cost === null) warnings.push(MarginWarning.COST_ROLE_NOT_MAPPED)
    if (ordersNotReadable > 0) warnings.push(MarginWarning.ORDERS_NOT_READABLE)
    if (unvaluedUnits > 0) warnings.push(MarginWarning.UNVALUED_UNITS)
    const reconciled = reconcileMargin(orderRevenue, orderCost, ledger.revenue, ledger.cost)
    return {
      from: query.from,
      to: query.to,
      storeId: query.storeId ?? null,
      rows: views,
      totals: {
        unitsSold: views.reduce((sum, row) => sum + row.unitsSold, 0),
        revenueCents: orderRevenue,
        costCents: orderCost,
        marginCents: orderRevenue - orderCost,
        marginBps: marginBps(orderRevenue, orderCost)
      },
      ledger: {
        revenueCents: reconciled.ledgerRevenueCents,
        costCents: reconciled.ledgerCostCents,
        revenueDifferenceCents: reconciled.revenueDifferenceCents,
        costDifferenceCents: reconciled.costDifferenceCents
      },
      returns: { revenueCents: ledger.returnsRevenue, costCents: ledger.returnsCost },
      ordersUsed,
      ordersNotReadable,
      unvaluedUnits,
      warnings
    }
  }

  async marginCsvRows(
    organizationId: string,
    query: FlowQuery,
    actor: Actor
  ): Promise<MarginCsvRow[]> {
    const view = await this.margin(organizationId, query)
    const blank = { storeId: null, productId: null, name: null }
    const figures = {
      unitsSold: null,
      revenueCents: null,
      costCents: null,
      marginCents: null,
      marginBps: null
    }
    const rows: MarginCsvRow[] = [
      ...view.rows.map(row => ({
        section: MarginCsvSection.PRODUCT,
        storeId: row.storeId,
        productId: row.productId,
        name: row.productName,
        unitsSold: row.unitsSold,
        revenueCents: row.revenueCents,
        costCents: row.costCents,
        marginCents: row.marginCents,
        marginBps: row.marginBps
      })),
      { section: MarginCsvSection.TOTAL, ...blank, ...view.totals },
      {
        section: MarginCsvSection.LEDGER,
        ...blank,
        ...figures,
        revenueCents: view.ledger.revenueCents,
        costCents: view.ledger.costCents,
        marginCents:
          view.ledger.revenueCents === null || view.ledger.costCents === null
            ? null
            : view.ledger.revenueCents - view.ledger.costCents
      },
      {
        section: MarginCsvSection.RETURNS,
        ...blank,
        ...figures,
        revenueCents: view.returns.revenueCents,
        costCents: view.returns.costCents
      },
      ...view.warnings.map(warning => ({
        section: MarginCsvSection.WARNING,
        ...blank,
        name: warning,
        ...figures
      }))
    ]
    // A product list is bounded by the catalogue, but a file is held to the cap of every other one
    if (rows.length > FinanceReportLimits.MAX_CSV_ROWS) {
      throw new PlatformException(
        ErrorCodes.EXPORT_TOO_LARGE,
        'the file would be larger than one export',
        HttpStatusCodes.BAD_REQUEST
      )
    }
    this.audit.log({
      action: AuditAction.FINANCE_EXPORTED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: FinanceResourceTypes.REPORT,
      resourceId: organizationId,
      metadata: {
        report: FinanceReport.MARGIN,
        from: query.from,
        to: query.to,
        storeId: query.storeId ?? '',
        rows: rows.length
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return rows
  }

  private async requireStore(organizationId: string, storeId: string | undefined): Promise<void> {
    if (storeId === undefined) return
    const found = await this.prisma.client.store.count({ where: { id: storeId, organizationId } })
    if (found === 0) throw resourceNotFound('store')
  }

  // The revenue and the cost of goods the ledger holds for the sale entries of the range, by the accounts the organization mapped to the
  // two roles, and what the return entries of the same range took back. A role with no account is null: the report is not compared
  // against zero.
  private async ledgerFigures(
    organizationId: string,
    query: FlowQuery
  ): Promise<{
    revenue: number | null
    cost: number | null
    returnsRevenue: number | null
    returnsCost: number | null
  }> {
    const db = this.prisma.client
    const mapped = new Set(
      (
        await db.accountRoleMapping.findMany({
          where: {
            organizationId,
            role: { in: [AccountRole.SALES_REVENUE, AccountRole.COST_OF_GOODS_SOLD] }
          },
          select: { role: true }
        })
      ).map(row => row.role)
    )
    const storeId = query.storeId ?? null
    const sums = await db.$queryRaw<LedgerRow[]>`
      SELECT e.type AS type, m.role AS role,
             COALESCE(SUM(l.credit_cents - l.debit_cents), 0)::bigint AS net
      FROM journal_lines l
      JOIN journal_entries e ON e.id = l.entry_id AND e.organization_id = l.organization_id
      JOIN account_role_mappings m ON m.account_id = l.account_id AND m.organization_id = l.organization_id
      WHERE l.organization_id = ${organizationId}
        AND e.type IN (${JournalEntryType.SALE}, ${JournalEntryType.SALE_RETURN})
        AND m.role IN (${AccountRole.SALES_REVENUE}, ${AccountRole.COST_OF_GOODS_SOLD})
        AND e.entry_date >= ${query.from}::date AND e.entry_date <= ${query.to}::date
        AND (${storeId}::text IS NULL OR l.store_id = ${storeId})
      GROUP BY e.type, m.role`
    const net = (type: JournalEntryType, role: AccountRole): bigint =>
      sums.find(row => row.type === String(type) && row.role === String(role))?.net ?? 0n
    const revenueMapped = mapped.has(AccountRole.SALES_REVENUE)
    const costMapped = mapped.has(AccountRole.COST_OF_GOODS_SOLD)
    return {
      // Revenue is a credit balance and cost of goods a debit one: the sign of each is the one a person reads
      revenue: revenueMapped
        ? centsAsNumber(net(JournalEntryType.SALE, AccountRole.SALES_REVENUE))
        : null,
      cost: costMapped
        ? centsAsNumber(-net(JournalEntryType.SALE, AccountRole.COST_OF_GOODS_SOLD))
        : null,
      returnsRevenue: revenueMapped
        ? centsAsNumber(-net(JournalEntryType.SALE_RETURN, AccountRole.SALES_REVENUE))
        : null,
      returnsCost: costMapped
        ? centsAsNumber(net(JournalEntryType.SALE_RETURN, AccountRole.COST_OF_GOODS_SOLD))
        : null
    }
  }

  // The name of each product as it is now, read under the organization of its store
  private async namesOf(
    organizationId: string,
    rows: readonly MarginRow[]
  ): Promise<Map<string, string>> {
    if (rows.length === 0) return new Map()
    const products = await this.prisma.client.product.findMany({
      where: {
        id: { in: [...new Set(rows.map(row => row.productId))] },
        store: { organizationId }
      },
      select: { id: true, storeId: true, name: true }
    })
    return new Map(products.map(product => [`${product.storeId}:${product.id}`, product.name]))
  }
}
