'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import type { FinanceBookLayoutView } from '@platform/api-client'

import { legalBookKindOf } from '../../lib/finance/book-view'
import {
  useFinanceFrozenBook,
  useFinanceFrozenBooks
} from '../../lib/finance/use-finance-statements'
import { useStore } from '../providers/store-context'
import { LoadFailed, PageLoading } from '../settings/states'
import { Button } from '../ui/button'

import { BookContent } from './book-content'

// The books frozen when their month was closed (TDD_18 §7): the file as it was, with its hash, which no later change of the layout or of
// the settings moves. Opening one shows the frozen book, not a rebuilt one.
export function FrozenBooksPanel({
  periodId,
  layouts
}: {
  periodId: string
  layouts: readonly FinanceBookLayoutView[] | undefined
}): ReactElement {
  const t = useTranslations('finance.books.frozenList')
  const tKinds = useTranslations('finance.books.kinds')
  const format = useFormatter()
  const { storeId } = useStore()
  const [openId, setOpenId] = useState<string | null>(null)
  const list = useFinanceFrozenBooks(storeId, periodId)
  const opened = useFinanceFrozenBook(storeId, openId)
  if (list.isError) return <LoadFailed error={list.error} onRetry={() => void list.refetch()} />
  if (list.data === undefined) return <PageLoading />
  const kindOf = (kind: string): string => {
    const known = legalBookKindOf(kind)
    return known === null ? kind : tKinds(known)
  }
  return (
    <section
      className="flex flex-col gap-3"
      aria-labelledby="finance-frozen-title"
      data-testid="finance-frozen-books"
    >
      <h2 id="finance-frozen-title" className="text-lg font-semibold">
        {t('title')}
      </h2>
      <p className="text-muted-foreground text-sm">{t('description')}</p>
      {list.data.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {list.data.map(item => (
            <li
              key={item.id}
              data-frozen-id={item.id}
              className="flex flex-col gap-1 px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between"
            >
              <span className="flex flex-col">
                <span className="font-medium">{kindOf(item.kind)}</span>
                <span className="text-muted-foreground text-xs">
                  {t('row', {
                    version: item.layoutVersion,
                    date: format.dateTime(new Date(item.closedAt), {
                      dateStyle: 'medium',
                      timeStyle: 'short'
                    })
                  })}
                </span>
              </span>
              <Button
                size="sm"
                variant="outline"
                aria-pressed={openId === item.id}
                onClick={() => setOpenId(openId === item.id ? null : item.id)}
              >
                {openId === item.id ? t('hide') : t('open')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {openId === null ? null : opened.isError ? (
        <LoadFailed error={opened.error} onRetry={() => void opened.refetch()} />
      ) : opened.data === undefined ? (
        <PageLoading />
      ) : (
        <BookContent book={opened.data} kind={opened.data.kind} layouts={layouts} />
      )}
    </section>
  )
}
