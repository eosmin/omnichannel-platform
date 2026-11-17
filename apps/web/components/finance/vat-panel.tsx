'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import type { FinanceVatMonthView, FinanceVatRowView, FinanceVatView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { SaleRecognition } from '@platform/core/domain'

import { BoundedRanges, flowFileName } from '../../lib/finance/statement-form'
import { vatBalanceKind, vatKindKeyOf, vatRowsOfMonth } from '../../lib/finance/tax-view'
import { useDownloadVatCsv, useFinanceVat } from '../../lib/finance/use-finance-tax'
import { usePercent } from '../../lib/finance/use-money'
import { useStore } from '../providers/store-context'
import { LoadFailed, PageLoading } from '../settings/states'

import { Amount, ClosedThroughNote, CsvDownloadButton } from './report-parts'
import { RangeFilters } from './statement-filters'
import { TotalLine } from './statement-section'

// The VAT of a range of days, month by month and by rate (TDD_18 §7). The output side is the tax the orders kept when they were sold (the
// snapshot of Step 4B.3b); the input side is what the journal holds on the VAT input account. The balance of a month is the api's
// (output less input) and the screen adds nothing. What the report could not read is counted and shown, never estimated. The file is the
// one the api writes and audits.
export function VatPanel({ lockedThrough }: { lockedThrough: string | null }): ReactElement {
  const t = useTranslations('finance.vat')
  const { storeId, can } = useStore()
  const [query, setQuery] = useState<{ from: string; to: string } | null>(null)
  const report = useFinanceVat(storeId, query)
  const download = useDownloadVatCsv(storeId)
  const data = report.data
  return (
    <div className="flex flex-col gap-4" data-testid="finance-vat">
      <RangeFilters
        bound={BoundedRanges.VAT}
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
            fileName={flowFileName('vat', query)}
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
          <VatNotices data={data} />
          {data.months.length === 0 ? (
            <p className="text-muted-foreground text-sm" data-testid="finance-vat-none">
              {t('none')}
            </p>
          ) : (
            data.months.map(month => <VatMonth key={month.month} data={data} view={month} />)
          )}
        </div>
      )}
    </div>
  )
}

// What the report did not read whole, with the count. Only what is not zero is said.
function VatNotices({ data }: { data: FinanceVatView }): ReactElement {
  const t = useTranslations('finance.vat')
  // The moment the sales count, in words: the api names it with the value of the setting
  const moment = Object.values(SaleRecognition).find(value => String(value) === data.recognizedOn)
  const recognizedOn = moment === undefined ? data.recognizedOn : t(`recognized.${moment}`)
  const notices = [
    { key: 'withoutSnapshot', count: data.ordersWithoutTaxSnapshot },
    { key: 'notReadable', count: data.ordersNotReadable },
    { key: 'returned', count: data.returnedOrdersIncluded }
  ] as const
  const shown = notices.filter(notice => notice.count > 0)
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs" data-testid="finance-vat-basis">
        {t('basis', {
          recognizedOn,
          start: data.accountingStartDate
        })}
      </p>
      {shown.length === 0 ? null : (
        <ul
          role="status"
          data-testid="finance-vat-notices"
          className="border-destructive/40 bg-destructive/5 flex list-disc flex-col gap-1 rounded-md border p-3 ps-8 text-sm"
        >
          {shown.map(notice => (
            <li key={notice.key} data-notice={notice.key}>
              {t(`notices.${notice.key}`, { count: notice.count })}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function VatMonth({
  data,
  view
}: {
  data: FinanceVatView
  view: FinanceVatMonthView
}): ReactElement {
  const month = view.month
  const t = useTranslations('finance.vat')
  const format = useFormatter()
  const { output, input, other } = vatRowsOfMonth(data.rows, month)
  // The month is a calendar month of the books: it is written in the language of the person, from its own digits (no zone moves it)
  const [year = 0, number = 1] = month.split('-').map(Number)
  const title = format.dateTime(new Date(Date.UTC(year, number - 1, 1)), {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC'
  })
  const balance = vatBalanceKind(view.balanceCents)
  return (
    <section
      className="flex flex-col gap-3"
      data-testid="finance-vat-month"
      data-month={month}
      aria-label={title}
    >
      <h3 className="text-base font-semibold">{title}</h3>
      <VatSideTable side="output" rows={output} totalCents={view.outputTaxCents} />
      <VatSideTable side="input" rows={input} totalCents={view.inputTaxCents} />
      {other.length === 0 ? null : (
        <ul
          role="status"
          data-testid="finance-vat-other"
          className="border-destructive/40 bg-destructive/5 flex list-disc flex-col gap-1 rounded-md border p-3 ps-8 text-sm"
        >
          {other.map(row => (
            <li key={`${row.side}-${row.kind}-${String(row.rateBps)}`}>
              {t('otherSide', { side: row.side, kind: row.kind })} <Amount cents={row.taxCents} />
            </li>
          ))}
        </ul>
      )}
      <TotalLine
        label={t('balance')}
        cents={view.balanceCents}
        testId="finance-vat-balance"
        note={t(`balanceKinds.${balance}`)}
      />
    </section>
  )
}

function VatSideTable({
  side,
  rows,
  totalCents
}: {
  side: 'output' | 'input'
  rows: readonly FinanceVatRowView[]
  // The month's total as the api computed it: the lines are never added again on the screen
  totalCents: number
}): ReactElement {
  const t = useTranslations('finance.vat')
  const tKinds = useTranslations('finance.vat.kinds')
  const percent = usePercent()
  return (
    <div className="overflow-x-auto rounded-md border" data-testid={`finance-vat-${side}`}>
      <table className="w-full min-w-[30rem] text-sm">
        <caption className="px-3 py-2 text-start text-sm font-medium">{t(`sides.${side}`)}</caption>
        <thead>
          <tr className="text-muted-foreground border-y text-xs">
            <th scope="col" className="px-3 py-2 text-start font-medium">
              {t(`kind.${side}`)}
            </th>
            <th scope="col" className="px-3 py-2 text-end font-medium">
              {t('rate')}
            </th>
            {side === 'output' ? (
              <th scope="col" className="px-3 py-2 text-end font-medium">
                {t('base')}
              </th>
            ) : null}
            <th scope="col" className="px-3 py-2 text-end font-medium">
              {t('tax')}
            </th>
            <th scope="col" className="px-3 py-2 text-end font-medium">
              {t('documents')}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={side === 'output' ? 5 : 4} className="text-muted-foreground px-3 py-2">
                {t('noLines')}
              </td>
            </tr>
          ) : (
            rows.map(row => {
              const kind = vatKindKeyOf(row.kind)
              return (
                <tr key={`${row.kind}-${String(row.rateBps)}`} data-kind={row.kind}>
                  <th scope="row" className="px-3 py-2 text-start font-normal">
                    {kind === null ? row.kind : tKinds(kind)}
                  </th>
                  <td className="px-3 py-2 text-end tabular-nums">
                    {row.rateBps === null ? t('noRate') : percent(row.rateBps)}
                  </td>
                  {side === 'output' ? (
                    <td className="px-3 py-2 text-end">
                      {row.baseCents === null ? null : <Amount cents={row.baseCents} />}
                    </td>
                  ) : null}
                  <td className="px-3 py-2 text-end">
                    <Amount cents={row.taxCents} />
                  </td>
                  <td className="px-3 py-2 text-end tabular-nums">{row.documents}</td>
                </tr>
              )
            })
          )}
        </tbody>
        <tfoot>
          <tr
            className="bg-muted/50 border-t font-semibold"
            data-testid={`finance-vat-${side}-total`}
          >
            <th scope="row" colSpan={side === 'output' ? 3 : 2} className="px-3 py-2 text-start">
              {t(`totals.${side}`)}
            </th>
            <td className="px-3 py-2 text-end">
              <Amount cents={totalCents} />
            </td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
