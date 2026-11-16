'use client'

import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { ClientPermissions } from '@platform/core/auth'

import { flowFileName } from '../../lib/finance/statement-form'
import {
  useDownloadIncomeStatementCsv,
  useFinanceIncomeStatement
} from '../../lib/finance/use-finance-statements'
import { useStore } from '../providers/store-context'
import { LoadFailed, PageLoading } from '../settings/states'

import { CsvDownloadButton, ClosedThroughNote, ReportWarnings } from './report-parts'
import { RangeFilters } from './statement-filters'
import { StatementSection, TotalLine } from './statement-section'

// The income statement of a range of days (TDD_18 §10): what came in, what the sales cost, the gross margin, the expenses and the result.
// The sections are the accounts of each type of the chart of the accountant; the margin and the result are the api's own sums.
export function IncomeStatementPanel({
  lockedThrough
}: {
  lockedThrough: string | null
}): ReactElement {
  const t = useTranslations('finance.statements.income')
  const { storeId, can } = useStore()
  const [query, setQuery] = useState<{ from: string; to: string } | null>(null)
  const statement = useFinanceIncomeStatement(storeId, query)
  const download = useDownloadIncomeStatementCsv(storeId)
  const data = statement.data
  return (
    <div className="flex flex-col gap-4" data-testid="finance-income-statement">
      <p className="text-muted-foreground text-sm">{t('description')}</p>
      <RangeFilters
        onApply={next => {
          // The same question again is a new read: the books may have moved since
          if (query?.from === next.from && query.to === next.to) void statement.refetch()
          setQuery(next)
        }}
      >
        {query !== null && can(ClientPermissions.FINANCE_EXPORT) ? (
          <CsvDownloadButton
            label={t('download')}
            fileName={flowFileName('income-statement', query)}
            query={query}
            run={input => download.mutateAsync(input)}
            isPending={download.isPending}
          />
        ) : null}
      </RangeFilters>
      {query === null ? (
        <p className="text-muted-foreground text-sm">{t('pick')}</p>
      ) : statement.isError ? (
        <LoadFailed error={statement.error} onRetry={() => void statement.refetch()} />
      ) : data === undefined ? (
        <PageLoading />
      ) : (
        <div className="flex flex-col gap-4">
          <ClosedThroughNote lockedThrough={lockedThrough} lastDay={query.to} />
          <ReportWarnings warnings={data.warnings} />
          <StatementSection
            testId="finance-statement-income"
            title={t('income')}
            totalLabel={t('incomeTotal')}
            section={data.income}
            emptyText={t('none')}
          />
          <StatementSection
            testId="finance-statement-cost"
            title={t('costOfSales')}
            totalLabel={t('costOfSalesTotal')}
            section={data.costOfSales}
            emptyText={t('none')}
          />
          <TotalLine
            label={t('grossMargin')}
            cents={data.grossMarginCents}
            testId="finance-statement-gross-margin"
          />
          <StatementSection
            testId="finance-statement-expenses"
            title={t('expenses')}
            totalLabel={t('expensesTotal')}
            section={data.expenses}
            emptyText={t('none')}
          />
          <TotalLine
            label={t('netResult')}
            cents={data.netResultCents}
            testId="finance-statement-net-result"
          />
        </div>
      )}
    </div>
  )
}
