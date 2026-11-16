'use client'

import { FileWarning, Snowflake } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import type { FinanceBookLayoutView, FinanceBookView } from '@platform/api-client'
import { PeriodStatus } from '@platform/core/domain'

import {
  BOOK_ROWS_SHOWN,
  bookColumns,
  bookWarnings,
  isCentsCell,
  moneyColumnsAreKnown,
  totalCells
} from '../../lib/finance/book-view'

import { Amount } from './report-parts'

// A legal book on screen (TDD_18 §7). **[ACCOUNTANT]** The layout is the organization's own data until an accountant confirms it, and a
// book that is not confirmed says so above its rows, in every state (open month, closed month, frozen): the page never presents it as
// the legal book. A closed month is a frozen report; one that could not be frozen says why it is rebuilt.
export function BookContent({
  book,
  kind,
  layouts
}: {
  book: FinanceBookView
  kind: string
  layouts: readonly FinanceBookLayoutView[] | undefined
}): ReactElement {
  const t = useTranslations('finance.books')
  const columns = bookColumns(book, layouts, kind)
  const totals = totalCells(columns, book.totals)
  const shown = book.rows.slice(0, BOOK_ROWS_SHOWN)
  const closed = book.period.status === String(PeriodStatus.CLOSED)
  const warnings = bookWarnings(book.warnings)
  const truncated = book.rows.length > shown.length
  // The label of the totals row sits in the first column that is not money, so a layout that opens with an amount still says it is a total
  const labelAt = Math.max(
    0,
    columns.findIndex(column => !column.money)
  )
  return (
    <div className="flex flex-col gap-4" data-testid="finance-book" data-kind={kind}>
      {book.unvalidated ? (
        <p
          role="note"
          data-testid="finance-book-unvalidated"
          className="border-destructive/40 bg-destructive/5 flex items-start gap-2 rounded-md border p-3 text-sm font-medium"
        >
          <FileWarning aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            {t('unvalidated.title')}
            <span className="block font-normal">{t('unvalidated.body')}</span>
          </span>
        </p>
      ) : (
        <p data-testid="finance-book-confirmed" className="text-muted-foreground text-sm">
          {t('confirmed', { version: book.layout.version })}
        </p>
      )}
      {closed ? (
        <p
          data-testid="finance-book-frozen"
          data-frozen={String(book.frozen)}
          className="bg-muted/50 flex items-start gap-2 rounded-md p-3 text-sm"
        >
          <Snowflake aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>{book.frozen ? t('frozen') : t('closedNotFrozen')}</span>
        </p>
      ) : (
        <p data-testid="finance-book-open" className="text-muted-foreground text-sm">
          {t('openMonth')}
        </p>
      )}
      {moneyColumnsAreKnown(columns, book.totals) ? null : (
        <p role="note" data-testid="finance-book-fields-unknown" className="text-sm">
          {t('fieldsUnknown')}
        </p>
      )}
      {warnings.length === 0 ? null : (
        <div
          role="status"
          data-testid="finance-book-warnings"
          className="border-destructive/40 bg-destructive/5 flex flex-col gap-1 rounded-md border p-3 text-sm"
        >
          <p className="font-medium">{t('warnings.title')}</p>
          <ul className="list-disc pl-6">
            {warnings.map(item => (
              <li key={item.key} data-warning={item.key}>
                {t(`warnings.${item.key}`, { count: item.count })}
              </li>
            ))}
          </ul>
        </div>
      )}
      {book.rows.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-testid="finance-book-empty">
          {t('empty')}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full min-w-[40rem] text-sm" data-testid="finance-book-table">
              <thead>
                <tr className="text-muted-foreground border-b text-xs">
                  {book.header.map((header, index) => (
                    <th
                      key={index}
                      scope="col"
                      className={`px-3 py-2 font-medium ${columns[index]?.money === true ? 'text-end' : 'text-start'}`}
                    >
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {shown.map((row, rowIndex) => (
                  <tr key={rowIndex} data-testid="finance-book-row">
                    {row.map((cell, index) => (
                      <td
                        key={index}
                        className={`px-3 py-2 ${columns[index]?.money === true ? 'text-end' : 'text-start'}`}
                      >
                        {columns[index]?.money === true && isCentsCell(cell) ? (
                          <Amount cents={cell} />
                        ) : typeof cell === 'boolean' ? (
                          t(cell ? 'yes' : 'no')
                        ) : (
                          (cell ?? '')
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr
                  className="bg-muted/50 border-t font-semibold"
                  data-testid="finance-book-totals"
                >
                  {totals.map((total, index) => (
                    <td
                      key={index}
                      className={`px-3 py-2 ${columns[index]?.money === true ? 'text-end' : 'text-start'}`}
                    >
                      {index === labelAt ? (
                        <span>
                          {truncated ? t('totalsAllRows') : t('totals')}
                          {total === null ? null : (
                            <>
                              {' '}
                              <Amount cents={total} />
                            </>
                          )}
                        </span>
                      ) : total === null ? (
                        ''
                      ) : (
                        <Amount cents={total} />
                      )}
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="text-muted-foreground text-xs" data-testid="finance-book-count">
            {truncated
              ? t('showing', { shown: shown.length, total: book.rows.length })
              : t('count', { count: book.rows.length })}
          </p>
        </>
      )}
      <p
        className="text-muted-foreground font-mono text-xs break-all"
        data-testid="finance-book-sha"
      >
        {t('sha', { sha: book.contentSha256 })}
      </p>
    </div>
  )
}
