import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { PrismaService } from '@platform/core/database'
import {
  AccountRole,
  FinanceCurrency,
  FinanceReport,
  FinanceReportLimits,
  FinanceResourceTypes,
  FinanceTransactionKind,
  OrderStatus,
  SaleRecognition,
  VatLineKind,
  VatSide
} from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import { ExportLimits } from '@platform/core/exports'
import { vatLinesOfOrder } from '@platform/core/finance'
import { financeRefusal } from '@platform/core/finance-ledger'

import type { Actor } from '../tenancy'

import { vatReportCsv } from './finance-vat-report.csv'
import type { VatReportQuery } from './finance.schemas'
import { isoDay, type VatMonthView, type VatReportView, type VatRowView } from './finance.views'

interface Bucket {
  base: number | null
  tax: number
  // Orders (output) or entries that are not reversals (input) that make the line
  documents: number
}

// The VAT report of the organization (TDD_18 §7) for a range of days, month by month and by rate. The output side is read from the
// tax snapshot the orders keep, by the day the sale is recognized in the time zone of its store (`recognizeSaleOn`); the input side
// is the VAT_INPUT account of the journal, by the day of the entry and the rate the line names. It reads; it writes nothing.
//
// What it does not do yet: the tax of returns (E8) is posted but not taken off the report (HC-003), the orders made before the tax columns carry
// no snapshot and are counted apart (`ordersWithoutTaxSnapshot`) and not estimated, and the legal books (sales to consumers, to
// taxpayers, purchases) wait for the accountant's format (**[ACCOUNTANT]**, Step 4B.8).
@Injectable()
export class FinanceVatReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  // The same report as a file taken out (TDD_18 §7, §10): held to the cap of every other file (never cut short, a cut file looks whole to
  // an accountant) and audited with the range and the row count, never the rows. The figures are cents and the texts go through the writer
  // of the other exports, so a text that starts like a formula is written as text. The audit row is written the way every finance audit
  // row is (not awaited, debt (k) of 4B.8a).
  async csv(organizationId: string, query: VatReportQuery, actor: Actor): Promise<string> {
    const report = await this.report(organizationId, query)
    // One row for each line of the report, the balance of each month and each warning with a count
    const rows =
      report.rows.length +
      report.months.length +
      [
        report.ordersWithoutTaxSnapshot,
        report.ordersNotReadable,
        report.returnedOrdersIncluded
      ].filter(count => count > 0).length
    if (rows > FinanceReportLimits.MAX_CSV_ROWS) {
      throw new PlatformException(
        ErrorCodes.EXPORT_TOO_LARGE,
        'the file would be larger than one export: narrow the dates',
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
      metadata: { report: FinanceReport.VAT, from: report.from, to: report.to, rows },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return vatReportCsv(report)
  }

  async report(organizationId: string, query: VatReportQuery): Promise<VatReportView> {
    const db = this.prisma.client
    const settings = await db.financeSettings.findUnique({
      where: { organizationId },
      select: { recognizeSaleOn: true, accountingStartDate: true }
    })
    if (settings === null) throw financeRefusal(ErrorCodes.FINANCE_SETUP_REQUIRED)
    const recognizedOn = settings.recognizeSaleOn as SaleRecognition
    const buckets = new Map<
      string,
      Bucket & { month: string; side: VatSide; kind: VatLineKind; rateBps: number | null }
    >()
    const touch = (
      month: string,
      side: VatSide,
      kind: VatLineKind,
      rateBps: number | null
    ): Bucket => {
      const key = `${month}|${side}|${kind}|${rateBps ?? ''}`
      let bucket = buckets.get(key)
      if (bucket === undefined) {
        bucket = {
          month,
          side,
          kind,
          rateBps,
          base: side === VatSide.OUTPUT ? 0 : null,
          tax: 0,
          documents: 0
        }
        buckets.set(key, bucket)
      }
      return bucket
    }

    // The orders of the range: the day each one is recognized is in the time zone of its store, which only the database can say for
    // all stores at once (the column holds a UTC instant without a zone, so it is read as UTC first). A cancelled order is never a sale, and one never delivered (or never shipped) is not one yet.
    const shipped = recognizedOn === SaleRecognition.SHIPPED
    const recognized = await db.$queryRaw<{ id: string; month: string; status: string }[]>`
      WITH known AS MATERIALIZED (SELECT lower(name) AS name FROM pg_timezone_names),
      zones AS (
        -- A zone the database does not know (a value written around the api, which validates it) is the UTC day, as the books do
        -- (dayInZone): one store with a bad zone must not leave the whole organization without its report. The list of zones is read once for the call, and as dayInZone reads a zone (a name of the database in any case; an abbreviation is not a zone there)
        SELECT s.id AS store_id,
               CASE WHEN lower(s.timezone) IN (SELECT name FROM known)
                    THEN s.timezone ELSE 'UTC' END AS timezone
        FROM stores s
        WHERE s.organization_id = ${organizationId}
      )
      SELECT x.id, x.status, to_char(((x.at AT TIME ZONE 'UTC') AT TIME ZONE x.timezone)::date, 'YYYY-MM') AS month
      FROM (
        SELECT o.id, z.timezone, o.status,
               CASE WHEN ${shipped}::boolean THEN o.shipped_at ELSE o.delivered_at END AS at
        FROM orders o
        JOIN zones z ON z.store_id = o.store_id
      ) x
      WHERE x.status <> ${OrderStatus.CANCELLED}
        AND x.at IS NOT NULL
        -- A plain range first, which an index can serve (the zones of the stores are at most a day away from UTC)
        AND x.at >= (${query.from}::date - 1)::timestamp
        AND x.at < (${query.to}::date + 2)::timestamp
        AND ((x.at AT TIME ZONE 'UTC') AT TIME ZONE x.timezone)::date BETWEEN ${query.from}::date AND ${query.to}::date
      ORDER BY x.id`
    let ordersWithoutTaxSnapshot = 0
    let ordersNotReadable = 0
    let returnedOrdersIncluded = 0
    for (let start = 0; start < recognized.length; start += ExportLimits.ROW_PAGE_SIZE) {
      const page = recognized.slice(start, start + ExportLimits.ROW_PAGE_SIZE)
      const orders = await db.order.findMany({
        where: { id: { in: page.map(row => row.id) }, store: { organizationId } },
        select: {
          id: true,
          discountCents: true,
          shippingCents: true,
          taxCents: true,
          pricesIncludeTax: true,
          shippingTaxRateBps: true,
          items: {
            select: {
              unitPriceCents: true,
              quantity: true,
              taxTreatment: true,
              taxRateBps: true,
              taxCents: true
            }
          }
        }
      })
      const monthOf = new Map(page.map(row => [row.id, row]))
      for (const order of orders) {
        const recognizedRow = monthOf.get(order.id)
        if (recognizedRow === undefined) continue
        const month = recognizedRow.month
        if (order.taxCents === null || order.pricesIncludeTax === null) {
          ordersWithoutTaxSnapshot += 1
          continue
        }
        const lines = vatLinesOfOrder({
          discountCents: order.discountCents,
          shippingCents: order.shippingCents,
          taxCents: order.taxCents,
          pricesIncludeTax: order.pricesIncludeTax,
          shippingTaxRateBps: order.shippingTaxRateBps,
          items: order.items.map(item => ({
            unitPriceCents: item.unitPriceCents,
            quantity: item.quantity,
            taxTreatment: item.taxTreatment ?? '',
            taxRateBps: item.taxRateBps,
            taxCents: item.taxCents ?? 0
          }))
        })
        if (lines === null || order.items.some(item => item.taxTreatment === null)) {
          ordersNotReadable += 1
          continue
        }
        for (const line of lines) {
          const bucket = touch(month, VatSide.OUTPUT, line.kind, line.rateBps)
          bucket.base = (bucket.base ?? 0) + line.baseCents
          bucket.tax += line.taxCents
          bucket.documents += 1
        }
        if (recognizedRow.status === (OrderStatus.RETURNED as string)) returnedOrdersIncluded += 1
      }
    }

    // The output side of the incomes registered by hand (TDD_18 §2.6, §7): the books credit the output account of the rate for them, and
    // they have no order. By the day of the entry, as the books do: a void is its own reversing entry, dated like the income it undoes
    // (the first open day when that month is closed), so it takes the tax out of the month of its entry. The base is what the income
    // received without the tax. An income with no rate carries no tax and is not a line; a rate of 0 % is a taxed line of rate 0, the
    // base of zero-rated incomes being read from the transactions (debt (f) of 4B.4a). The rate is the one the tax rate row has today
    // (a transaction keeps no snapshot of it, debt (q) of 4B.8b).
    {
      const rows = await db.$queryRaw<
        { month: string; rate_bps: number; base: bigint; cents: bigint; documents: bigint }[]
      >`
        SELECT to_char(e.entry_date, 'YYYY-MM') AS month, r.rate_bps,
               SUM(x.sign * (t.amount_cents - t.tax_cents))::bigint AS base,
               SUM(x.sign * t.tax_cents)::bigint AS cents,
               (COUNT(*) FILTER (WHERE x.sign = 1 AND t.voided_by_entry_id IS NULL))::bigint AS documents
        FROM finance_transactions t
        JOIN LATERAL (
          SELECT t.entry_id AS entry_id, 1 AS sign
          UNION ALL
          SELECT t.voided_by_entry_id, -1 WHERE t.voided_by_entry_id IS NOT NULL
        ) x ON TRUE
        JOIN journal_entries e ON e.id = x.entry_id AND e.organization_id = t.organization_id
        JOIN tax_rates r ON r.id = t.tax_rate_id AND r.organization_id = t.organization_id
        WHERE t.organization_id = ${organizationId}
          AND t.kind = ${FinanceTransactionKind.INCOME}
          -- A reversing entry is never dated before the income it undoes, so an income after the range has no leg in it
          AND t.occurred_on <= ${query.to}::date
          AND e.entry_date BETWEEN ${query.from}::date AND ${query.to}::date
        GROUP BY 1, 2
        -- An income and its void inside one month cancel out: no row of zeros
        HAVING SUM(x.sign * t.tax_cents) <> 0 OR SUM(x.sign * (t.amount_cents - t.tax_cents)) <> 0`
      for (const row of rows) {
        const bucket = touch(row.month, VatSide.OUTPUT, VatLineKind.TAXED, row.rate_bps)
        bucket.base = (bucket.base ?? 0) + Number(row.base)
        bucket.tax += Number(row.cents)
        bucket.documents += Number(row.documents)
      }
    }

    // The input side: the tax the books credited, from the lines of the account that holds it. The base is not on a line.
    {
      const rows = await db.$queryRaw<
        { month: string; rate_bps: number | null; cents: bigint; entries: bigint }[]
      >`
        SELECT to_char(e.entry_date, 'YYYY-MM') AS month, r.rate_bps,
               SUM(l.debit_cents - l.credit_cents)::bigint AS cents,
               (COUNT(DISTINCT e.id) FILTER (WHERE e.reverses_entry_id IS NULL))::bigint AS entries
        FROM journal_lines l
        JOIN journal_entries e ON e.id = l.entry_id AND e.organization_id = l.organization_id
        LEFT JOIN tax_rates r ON r.id = l.tax_rate_id AND r.organization_id = l.organization_id
        WHERE l.organization_id = ${organizationId}
          -- The account the VAT_INPUT role maps and the input account of every rate: a rate may post its credit elsewhere
          AND l.account_id IN (
            SELECT m.account_id FROM account_role_mappings m
            WHERE m.organization_id = ${organizationId} AND m.role = ${AccountRole.VAT_INPUT}
            UNION
            SELECT t.input_account_id FROM tax_rates t WHERE t.organization_id = ${organizationId}
          )
          AND e.entry_date BETWEEN ${query.from}::date AND ${query.to}::date
        GROUP BY 1, 2`
      for (const row of rows) {
        const bucket = touch(row.month, VatSide.INPUT, VatLineKind.TAXED, row.rate_bps)
        bucket.tax += Number(row.cents)
        bucket.documents += Number(row.entries)
      }
    }

    const rows: VatRowView[] = [...buckets.values()]
      .map(bucket => ({
        month: bucket.month,
        side: bucket.side,
        kind: bucket.kind,
        rateBps: bucket.rateBps,
        baseCents: bucket.base,
        taxCents: bucket.tax,
        documents: bucket.documents
      }))
      .sort(
        (a, b) =>
          a.month.localeCompare(b.month) ||
          a.side.localeCompare(b.side) ||
          a.kind.localeCompare(b.kind) ||
          (a.rateBps ?? -1) - (b.rateBps ?? -1)
      )
    const months = new Map<string, VatMonthView>()
    for (const row of rows) {
      const month = months.get(row.month) ?? {
        month: row.month,
        outputTaxCents: 0,
        inputTaxCents: 0,
        balanceCents: 0
      }
      if (row.side === VatSide.OUTPUT) month.outputTaxCents += row.taxCents
      else month.inputTaxCents += row.taxCents
      month.balanceCents = month.outputTaxCents - month.inputTaxCents
      months.set(row.month, month)
    }
    return {
      from: query.from,
      to: query.to,
      currency: FinanceCurrency,
      recognizedOn,
      accountingStartDate: isoDay(settings.accountingStartDate),
      rows,
      months: [...months.values()],
      ordersWithoutTaxSnapshot,
      ordersNotReadable,
      returnedOrdersIncluded
    }
  }
}
