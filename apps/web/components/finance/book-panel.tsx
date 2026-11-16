'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useMemo, useState } from 'react'

import { LegalBookKind } from '@platform/core/domain'

import { bookFileName } from '../../lib/finance/book-view'
import { useFinancePeriods } from '../../lib/finance/use-finance'
import {
  useDownloadBookCsv,
  useFinanceBook,
  useFinanceBookLayouts
} from '../../lib/finance/use-finance-statements'
import { useStore } from '../providers/store-context'
import { LoadFailed, PageLoading } from '../settings/states'

import { BookContent } from './book-content'
import { BookLayoutSummary } from './book-layout-summary'
import { SelectField } from './fields'
import { FrozenBooksPanel } from './frozen-books-panel'
import { CsvDownloadButton } from './report-parts'

// A legal book of a month (TDD_18 §7): the kind of book and the month are chosen, the book is read for them, and the file is the same
// book as the api writes it. The notice that the layout is unvalidated, when it is, sits above the rows and in the name of the file.
export function BookPanel(): ReactElement {
  const t = useTranslations('finance.books')
  const format = useFormatter()
  const { storeId } = useStore()
  const periods = useFinancePeriods(storeId, true)
  const layouts = useFinanceBookLayouts(storeId, true)
  const [kind, setKind] = useState<LegalBookKind>(LegalBookKind.SALES_TAXPAYERS)
  const [periodId, setPeriodId] = useState('')
  const query = periodId === '' ? null : { kind, periodId }
  const book = useFinanceBook(storeId, query)
  const download = useDownloadBookCsv(storeId)
  const ordered = useMemo(
    () => [...(periods.data ?? [])].sort((a, b) => b.year - a.year || b.month - a.month),
    [periods.data]
  )
  if (periods.isError) {
    return <LoadFailed error={periods.error} onRetry={() => void periods.refetch()} />
  }
  if (layouts.isError)
    return <LoadFailed error={layouts.error} onRetry={() => void layouts.refetch()} />
  // The layouts say which columns are money: the book waits for them, so it is never drawn once as plain numbers and then as amounts
  if (periods.data === undefined || layouts.isPending) return <PageLoading />
  const layout = layouts.data?.find(item => item.kind === String(kind))
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-3 sm:grid-cols-2" data-testid="finance-book-filters">
        <SelectField
          label={t('kind')}
          value={kind}
          onChange={value => setKind(value as LegalBookKind)}
        >
          {Object.values(LegalBookKind).map(value => (
            <option key={value} value={value}>
              {t(`kinds.${value}`)}
            </option>
          ))}
        </SelectField>
        <SelectField label={t('period')} value={periodId} onChange={setPeriodId}>
          <option value="">{t('periodPick')}</option>
          {ordered.map(period => (
            <option key={period.id} value={period.id}>
              {format.dateTime(new Date(Date.UTC(period.year, period.month - 1, 1)), {
                month: 'long',
                year: 'numeric',
                timeZone: 'UTC'
              })}
            </option>
          ))}
        </SelectField>
      </div>
      {layout === undefined ? null : <BookLayoutSummary layout={layout} />}
      {query === null ? (
        <p className="text-muted-foreground text-sm">
          {ordered.length === 0 ? t('noPeriods') : t('pick')}
        </p>
      ) : book.isError ? (
        <LoadFailed error={book.error} onRetry={() => void book.refetch()} />
      ) : book.data === undefined ? (
        <PageLoading />
      ) : (
        <div className="flex flex-col gap-4">
          <CsvDownloadButton
            label={book.data.unvalidated ? t('downloadDraft') : t('download')}
            fileName={bookFileName(
              kind,
              book.data.period,
              book.data.unvalidated ? t('draftTag') : null
            )}
            query={query}
            run={input => download.mutateAsync(input)}
            isPending={download.isPending}
          />
          <BookContent book={book.data} kind={kind} layouts={layouts.data} />
        </div>
      )}
      {query === null ? null : (
        <FrozenBooksPanel key={query.periodId} periodId={query.periodId} layouts={layouts.data} />
      )}
    </div>
  )
}
