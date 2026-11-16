'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import type { FinanceBookLayoutView } from '@platform/api-client'

import {
  layoutRestartOf,
  layoutSortOf,
  layoutSourceOf,
  layoutUnissuedOf,
  legalBookFieldOf
} from '../../lib/finance/book-view'

// The layout a book of a kind is built with, as the organization keeps it (read only here: **[ACCOUNTANT]** the layout is written
// with the accountant's word, and the editor waits for it, Step 4B.8b-4). The values of the closed lists are said in words; a value the
// screen does not know (a newer api) is shown as it came.
export function BookLayoutSummary({ layout }: { layout: FinanceBookLayoutView }): ReactElement {
  const t = useTranslations('finance.books.layout')
  const tFields = useTranslations('finance.books.fields')
  const source = layoutSourceOf(layout.source)
  const sort = layoutSortOf(layout.sort)
  const restart = layoutRestartOf(layout.correlativeRestart)
  const unissued = layoutUnissuedOf(layout.unissuedSales)
  return (
    <details className="rounded-md border p-3 text-sm" data-testid="finance-book-layout">
      <summary className="cursor-pointer font-medium">
        {t('summary', {
          version: layout.version,
          source: source === null ? layout.source : t(`sources.${source}`)
        })}
      </summary>
      <dl className="mt-3 grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">{t('confirmedLabel')}</dt>
        <dd>{layout.accountantConfirmed ? t('confirmedYes') : t('confirmedNo')}</dd>
        <dt className="text-muted-foreground">{t('sortLabel')}</dt>
        <dd>{sort === null ? layout.sort : t(`sorts.${sort}`)}</dd>
        <dt className="text-muted-foreground">{t('correlativeLabel')}</dt>
        <dd>
          {t('correlative', {
            start: layout.correlativeStart,
            restart: restart === null ? layout.correlativeRestart : t(`restarts.${restart}`)
          })}
        </dd>
        <dt className="text-muted-foreground">{t('unissuedLabel')}</dt>
        <dd>{unissued === null ? layout.unissuedSales : t(`unissued.${unissued}`)}</dd>
        <dt className="text-muted-foreground">{t('columnsLabel')}</dt>
        <dd>
          <ol className="list-decimal ps-5">
            {layout.columns.map((column, index) => {
              const field = legalBookFieldOf(column.field)
              return (
                <li key={index}>
                  {field === null ? column.field : tFields(field)}
                  {column.label === null ? null : (
                    <span className="text-muted-foreground"> — {column.label}</span>
                  )}
                </li>
              )
            })}
          </ol>
        </dd>
      </dl>
    </details>
  )
}
