'use client'

import { TriangleAlert } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import type { FinanceMarginView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'

import { BoundedRanges, flowFileName } from '../../lib/finance/statement-form'
import { marginGroups, marginWarningKeyOf, shortStoreId } from '../../lib/finance/tax-view'
import { useDownloadMarginCsv, useFinanceMargin } from '../../lib/finance/use-finance-tax'
import { usePercent } from '../../lib/finance/use-money'
import { useProfile } from '../../lib/use-profile'
import { useStore } from '../providers/store-context'
import { LoadFailed, PageLoading } from '../settings/states'

import { Amount, ClosedThroughNote, CsvDownloadButton } from './report-parts'
import { RangeFilters } from './statement-filters'

// The margin by product and store (TDD_18 §10): what each order recorded as revenue, less the cost its stock movements carried (the
// weighted average cost of the moment), for the sales the ledger recognized in the range, set beside the revenue and the cost of goods
// the ledger itself holds. The difference is shown and never forced to zero; a role with no account in the settings is said, and the
// ledger side is then not shown at all (never a zero that looks like a match). A report only reads: it writes nothing to the books.
export function MarginPanel({ lockedThrough }: { lockedThrough: string | null }): ReactElement {
  const t = useTranslations('finance.margin')
  const { storeId, can } = useStore()
  const [query, setQuery] = useState<{ from: string; to: string } | null>(null)
  const report = useFinanceMargin(storeId, query)
  const download = useDownloadMarginCsv(storeId)
  const data = report.data
  return (
    <div className="flex flex-col gap-4" data-testid="finance-margin">
      <RangeFilters
        bound={BoundedRanges.MARGIN}
        applied={query}
        onApply={next => {
          // The same question again is a new read: the books may have moved since
          if (query?.from === next.from && query.to === next.to) void report.refetch()
          setQuery(next)
        }}
      >
        {query !== null && can(ClientPermissions.FINANCE_EXPORT) ? (
          <CsvDownloadButton
            label={t('download')}
            fileName={flowFileName('margin', query)}
            query={query}
            run={input => download.mutateAsync(input)}
            isPending={download.isPending}
          />
        ) : null}
      </RangeFilters>
      {query === null ? (
        <p className="text-muted-foreground text-sm">{t('pick')}</p>
      ) : report.isError ? (
        <LoadFailed error={report.error} onRetry={() => void report.refetch()} />
      ) : data === undefined ? (
        <PageLoading />
      ) : (
        <div
          className={`flex flex-col gap-4 ${report.isFetching ? 'opacity-60' : ''}`}
          aria-busy={report.isFetching}
        >
          <ClosedThroughNote lockedThrough={lockedThrough} lastDay={query.to} />
          <MarginWarnings data={data} />
          <MarginTable data={data} />
          <LedgerComparison data={data} />
        </div>
      )}
    </div>
  )
}

function MarginWarnings({ data }: { data: FinanceMarginView }): ReactElement | null {
  const t = useTranslations('finance.margin')
  const counts = [
    { key: 'ordersUsed', count: data.ordersUsed, alert: false },
    { key: 'ordersNotReadable', count: data.ordersNotReadable, alert: true },
    { key: 'unvaluedUnits', count: data.unvaluedUnits, alert: true }
  ] as const
  return (
    <div className="flex flex-col gap-2">
      {data.warnings.length === 0 ? null : (
        <div
          role="status"
          data-testid="finance-margin-warnings"
          className="border-destructive/40 bg-destructive/5 flex flex-col gap-1 rounded-md border p-3 text-sm"
        >
          <p className="flex items-center gap-2 font-medium">
            <TriangleAlert aria-hidden className="size-4 shrink-0" />
            {t('warningsTitle')}
          </p>
          <ul className="list-disc ps-6">
            {data.warnings.map((warning, index) => {
              const key = marginWarningKeyOf(warning)
              return (
                <li key={`${warning}-${String(index)}`} data-warning={warning}>
                  {key === null ? warning : t(`warnings.${key}`)}
                </li>
              )
            })}
          </ul>
        </div>
      )}
      <ul className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {counts
          .filter(item => !item.alert || item.count > 0)
          .map(item => (
            <li key={item.key} data-count={item.key}>
              {t(`counts.${item.key}`, { count: item.count })}
            </li>
          ))}
      </ul>
    </div>
  )
}

function MarginTable({ data }: { data: FinanceMarginView }): ReactElement {
  const t = useTranslations('finance.margin')
  const percent = usePercent()
  const profile = useProfile()
  const names = new Map((profile.data?.memberships ?? []).map(m => [m.storeId, m.storeName]))
  const groups = marginGroups(data.rows, id => names.get(id) ?? shortStoreId(id))
  if (data.rows.length === 0) {
    return (
      <p className="text-muted-foreground text-sm" data-testid="finance-margin-none">
        {t('none')}
      </p>
    )
  }
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full min-w-[40rem] text-sm" data-testid="finance-margin-table">
        <thead>
          <tr className="text-muted-foreground border-b text-xs">
            <th scope="col" className="px-3 py-2 text-start font-medium">
              {t('product')}
            </th>
            <th scope="col" className="px-3 py-2 text-end font-medium">
              {t('units')}
            </th>
            <th scope="col" className="px-3 py-2 text-end font-medium">
              {t('revenue')}
            </th>
            <th scope="col" className="px-3 py-2 text-end font-medium">
              {t('cost')}
            </th>
            <th scope="col" className="px-3 py-2 text-end font-medium">
              {t('margin')}
            </th>
            <th scope="col" className="px-3 py-2 text-end font-medium">
              {t('marginPercent')}
            </th>
          </tr>
        </thead>
        {groups.map(group => (
          <tbody
            key={group.storeId}
            className="divide-y border-b"
            data-testid="finance-margin-store"
            data-store={group.storeId}
          >
            <tr className="bg-muted/30">
              <th
                scope="rowgroup"
                colSpan={6}
                className="px-3 py-2 text-start text-xs font-semibold"
              >
                {group.name}
              </th>
            </tr>
            {group.rows.map(row => {
              return (
                <tr key={row.productId} data-product={row.productId}>
                  <th scope="row" className="px-3 py-2 text-start font-normal">
                    {row.productName ?? t('unnamedProduct')}
                  </th>
                  <td className="px-3 py-2 text-end tabular-nums">{row.unitsSold}</td>
                  <td className="px-3 py-2 text-end">
                    <Amount cents={row.revenueCents} />
                  </td>
                  <td className="px-3 py-2 text-end">
                    <Amount cents={row.costCents} />
                  </td>
                  <td className="px-3 py-2 text-end">
                    <Amount cents={row.marginCents} />
                  </td>
                  <td className="px-3 py-2 text-end tabular-nums">
                    {row.marginBps === null ? t('noPercent') : percent(row.marginBps)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        ))}
        <tfoot>
          <tr className="bg-muted/50 font-semibold" data-testid="finance-margin-total">
            <th scope="row" className="px-3 py-2 text-start">
              {t('totals')}
            </th>
            <td className="px-3 py-2 text-end tabular-nums">{data.totals.unitsSold}</td>
            <td className="px-3 py-2 text-end">
              <Amount cents={data.totals.revenueCents} />
            </td>
            <td className="px-3 py-2 text-end">
              <Amount cents={data.totals.costCents} />
            </td>
            <td className="px-3 py-2 text-end">
              <Amount cents={data.totals.marginCents} />
            </td>
            <td className="px-3 py-2 text-end tabular-nums">
              {data.totals.marginBps === null ? t('noPercent') : percent(data.totals.marginBps)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

// The same sales as the ledger holds them: a figure that is null is a role with no account (the report says so and compares against
// nothing), and what the returns of the range took back is shown apart because the products above are gross of returns
function LedgerComparison({ data }: { data: FinanceMarginView }): ReactElement {
  const t = useTranslations('finance.margin.ledger')
  const lines = [
    {
      key: 'revenue',
      ledger: data.ledger.revenueCents,
      difference: data.ledger.revenueDifferenceCents,
      report: data.totals.revenueCents,
      returned: data.returns.revenueCents
    },
    {
      key: 'cost',
      ledger: data.ledger.costCents,
      difference: data.ledger.costDifferenceCents,
      report: data.totals.costCents,
      returned: data.returns.costCents
    }
  ] as const
  return (
    <section className="flex flex-col gap-2" data-testid="finance-margin-ledger">
      <h3 className="text-base font-semibold">{t('title')}</h3>
      <p className="text-muted-foreground text-sm">{t('description')}</p>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full min-w-[30rem] text-sm">
          <thead>
            <tr className="text-muted-foreground border-b text-xs">
              <th scope="col" className="px-3 py-2 text-start font-medium">
                <span className="sr-only">{t('line')}</span>
              </th>
              <th scope="col" className="px-3 py-2 text-end font-medium">
                {t('report')}
              </th>
              <th scope="col" className="px-3 py-2 text-end font-medium">
                {t('books')}
              </th>
              <th scope="col" className="px-3 py-2 text-end font-medium">
                {t('difference')}
              </th>
              <th scope="col" className="px-3 py-2 text-end font-medium">
                {t('returned')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {lines.map(line => (
              <tr key={line.key} data-line={line.key}>
                <th scope="row" className="px-3 py-2 text-start font-normal">
                  {t(`lines.${line.key}`)}
                </th>
                <td className="px-3 py-2 text-end">
                  <Amount cents={line.report} />
                </td>
                <NullableAmount cents={line.ledger} empty={t('notMapped')} />
                <NullableAmount cents={line.difference} empty={t('notMapped')} />
                <NullableAmount cents={line.returned} empty={t('notMapped')} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function NullableAmount({ cents, empty }: { cents: number | null; empty: string }): ReactElement {
  return (
    <td className="px-3 py-2 text-end" data-empty={String(cents === null)}>
      {cents === null ? (
        <span className="text-muted-foreground">{empty}</span>
      ) : (
        <Amount cents={cents} />
      )}
    </td>
  )
}
