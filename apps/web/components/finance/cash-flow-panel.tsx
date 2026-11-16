'use client'

import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { ClientPermissions } from '@platform/core/auth'

import { flowFileName } from '../../lib/finance/statement-form'
import { sourceKeyOf } from '../../lib/finance/statement-view'
import {
  useDownloadCashFlowCsv,
  useFinanceCashFlow
} from '../../lib/finance/use-finance-statements'
import { useStore } from '../providers/store-context'
import { LoadFailed, PageLoading } from '../settings/states'

import { Amount, CsvDownloadButton, ClosedThroughNote, ReportWarnings } from './report-parts'
import { RangeFilters } from './statement-filters'
import { TotalLine } from './statement-section'

// The cash flow of a range of days (TDD_18 §10): the money that came in and went out of the cash and bank accounts, by the kind of record
// that moved it, from the balance at the start to the balance at the end. The api says whether the two ends close; the page says it too.
export function CashFlowPanel({ lockedThrough }: { lockedThrough: string | null }): ReactElement {
  const t = useTranslations('finance.statements.cash')
  const tSources = useTranslations('finance.statements.sources')
  const { storeId, can } = useStore()
  const [query, setQuery] = useState<{ from: string; to: string } | null>(null)
  const flow = useFinanceCashFlow(storeId, query)
  const download = useDownloadCashFlowCsv(storeId)
  const data = flow.data
  return (
    <div className="flex flex-col gap-4" data-testid="finance-cash-flow">
      <p className="text-muted-foreground text-sm">{t('description')}</p>
      <RangeFilters
        onApply={next => {
          // The same question again is a new read: the books may have moved since
          if (query?.from === next.from && query.to === next.to) void flow.refetch()
          setQuery(next)
        }}
      >
        {query !== null && can(ClientPermissions.FINANCE_EXPORT) ? (
          <CsvDownloadButton
            label={t('download')}
            fileName={flowFileName('cash-flow', query)}
            query={query}
            run={input => download.mutateAsync(input)}
            isPending={download.isPending}
          />
        ) : null}
      </RangeFilters>
      {query === null ? (
        <p className="text-muted-foreground text-sm">{t('pick')}</p>
      ) : flow.isError ? (
        <LoadFailed error={flow.error} onRetry={() => void flow.refetch()} />
      ) : data === undefined ? (
        <PageLoading />
      ) : (
        <div className="flex flex-col gap-4">
          <ClosedThroughNote lockedThrough={lockedThrough} lastDay={query.to} />
          <ReportWarnings warnings={data.warnings} />
          <TotalLine label={t('opening')} cents={data.openingCents} testId="finance-cash-opening" />
          {data.sources.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('none')}</p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full min-w-[28rem] text-sm" data-testid="finance-cash-sources">
                <thead>
                  <tr className="text-muted-foreground border-b text-start text-xs">
                    <th scope="col" className="px-3 py-2 text-start font-medium">
                      {t('source')}
                    </th>
                    <th scope="col" className="px-3 py-2 text-end font-medium">
                      {t('inflow')}
                    </th>
                    <th scope="col" className="px-3 py-2 text-end font-medium">
                      {t('outflow')}
                    </th>
                    <th scope="col" className="px-3 py-2 text-end font-medium">
                      {t('net')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {data.sources.map(source => {
                    const key = sourceKeyOf(source.source)
                    return (
                      <tr key={source.source} data-source={source.source}>
                        <th scope="row" className="px-3 py-2 text-start font-normal">
                          {key === null ? source.source : tSources(key)}
                        </th>
                        <td className="px-3 py-2 text-end">
                          <Amount cents={source.inflowCents} />
                        </td>
                        <td className="px-3 py-2 text-end">
                          <Amount cents={source.outflowCents} />
                        </td>
                        <td className="px-3 py-2 text-end">
                          <Amount cents={source.netCents} />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr
                    className="bg-muted/50 border-t font-semibold"
                    data-testid="finance-cash-total"
                  >
                    <th scope="row" className="px-3 py-2 text-start">
                      {t('total')}
                    </th>
                    <td className="px-3 py-2 text-end">
                      <Amount cents={data.inflowCents} />
                    </td>
                    <td className="px-3 py-2 text-end">
                      <Amount cents={data.outflowCents} />
                    </td>
                    <td className="px-3 py-2 text-end">
                      <Amount cents={data.netCents} />
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          <TotalLine
            label={t('closing')}
            cents={data.closingCents}
            testId="finance-cash-closing"
            note={data.closes ? t('closes') : t('doesNotClose')}
          />
        </div>
      )}
    </div>
  )
}
