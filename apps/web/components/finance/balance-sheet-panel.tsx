'use client'

import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { ClientPermissions } from '@platform/core/auth'

import { dayFileName } from '../../lib/finance/statement-form'
import {
  useDownloadBalanceSheetCsv,
  useFinanceBalanceSheet
} from '../../lib/finance/use-finance-statements'
import { useStore } from '../providers/store-context'
import { LoadFailed, PageLoading } from '../settings/states'

import { CsvDownloadButton, ClosedThroughNote, ReportWarnings } from './report-parts'
import { DayFilters } from './statement-filters'
import { StatementSection, TotalLine } from './statement-section'

// The balance sheet of a day (TDD_18 §10): what the business has, what it owes and what is its own. The result of the year that no
// closing entry moved to equity yet is a line of its own, so the identity assets = liabilities + equity + result can be read on the page.
export function BalanceSheetPanel({
  lockedThrough
}: {
  lockedThrough: string | null
}): ReactElement {
  const t = useTranslations('finance.statements.balance')
  const { storeId, can } = useStore()
  const [query, setQuery] = useState<{ asOf: string } | null>(null)
  const sheet = useFinanceBalanceSheet(storeId, query)
  const download = useDownloadBalanceSheetCsv(storeId)
  const data = sheet.data
  return (
    <div className="flex flex-col gap-4" data-testid="finance-balance-sheet">
      <p className="text-muted-foreground text-sm">{t('description')}</p>
      <DayFilters
        onApply={next => {
          // The same question again is a new read: the books may have moved since
          if (query?.asOf === next.asOf) void sheet.refetch()
          setQuery(next)
        }}
      >
        {query !== null && can(ClientPermissions.FINANCE_EXPORT) ? (
          <CsvDownloadButton
            label={t('download')}
            fileName={dayFileName('balance-sheet', query.asOf)}
            query={query}
            run={input => download.mutateAsync(input)}
            isPending={download.isPending}
          />
        ) : null}
      </DayFilters>
      {query === null ? (
        <p className="text-muted-foreground text-sm">{t('pick')}</p>
      ) : sheet.isError ? (
        <LoadFailed error={sheet.error} onRetry={() => void sheet.refetch()} />
      ) : data === undefined ? (
        <PageLoading />
      ) : (
        <div className="flex flex-col gap-4">
          <ClosedThroughNote lockedThrough={lockedThrough} lastDay={query.asOf} />
          <ReportWarnings warnings={data.warnings} />
          <StatementSection
            testId="finance-statement-assets"
            title={t('assets')}
            totalLabel={t('assetsTotal')}
            section={data.assets}
            emptyText={t('none')}
          />
          <StatementSection
            testId="finance-statement-liabilities"
            title={t('liabilities')}
            totalLabel={t('liabilitiesTotal')}
            section={data.liabilities}
            emptyText={t('none')}
          />
          <StatementSection
            testId="finance-statement-equity"
            title={t('equity')}
            totalLabel={t('equityTotal')}
            section={data.equity}
            emptyText={t('none')}
          />
          <TotalLine
            label={t('result')}
            cents={data.resultCents}
            testId="finance-statement-result"
            note={t('resultNote')}
          />
          <TotalLine
            label={t('equityWithResult')}
            cents={data.equityWithResultCents}
            testId="finance-statement-equity-with-result"
            note={
              data.balanced === null
                ? t('balancedSlice')
                : data.balanced
                  ? t('balanced')
                  : t('notBalanced')
            }
          />
        </div>
      )}
    </div>
  )
}
