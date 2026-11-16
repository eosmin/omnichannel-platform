'use client'

import { useFormatter, useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import type { FinancePostingView } from '@platform/api-client'

import { useFinancePostings, useRetryFinancePosting } from '../../lib/finance/use-finance'
import { toast } from '../../lib/toast'
import { useCodeText, useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

// The events the books could not post (TDD_18 §4.2, E-failures): each says what it was and why, and can be tried again once the
// cause is fixed (a role without an account, a closed period). Nothing is hidden: a sale that is not in the books is listed here.
export function PostingsPanel(): ReactElement | null {
  const t = useTranslations('finance.postings')
  const { storeId } = useStore()
  const postings = useFinancePostings(storeId, true)
  if (postings.isError) return <p className="text-muted-foreground text-sm">{t('failed')}</p>
  if (postings.data === undefined) return null
  return (
    <section className="flex flex-col gap-2" aria-labelledby="finance-postings-title">
      <h2 id="finance-postings-title" className="text-lg font-semibold">
        {t('title')}
      </h2>
      <p className="text-muted-foreground text-sm">{t('description')}</p>
      {postings.data.data.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-testid="finance-postings-empty">
          {t('empty')}
        </p>
      ) : (
        <ul className="divide-y rounded-md border" data-testid="finance-postings">
          {postings.data.data.map(posting => (
            <PostingRow key={posting.id} posting={posting} />
          ))}
          {postings.data.hasMore ? (
            <li className="text-muted-foreground px-4 py-2 text-xs">{t('more')}</li>
          ) : null}
        </ul>
      )}
    </section>
  )
}

function PostingRow({ posting }: { posting: FinancePostingView }): ReactElement {
  const t = useTranslations('finance.postings')
  const format = useFormatter()
  const codeText = useCodeText()
  const errorText = useErrorText()
  const { storeId } = useStore()
  const retry = useRetryFinancePosting(storeId)
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium">
          {t('event', { source: posting.sourceType, kind: posting.eventKind })}
        </span>
        <span className="text-destructive text-sm">{codeText(posting.reason)}</span>
        <span className="text-muted-foreground text-xs">
          {t('attempts', { count: posting.attempts })} ·{' '}
          {format.dateTime(new Date(posting.updatedAt), {
            dateStyle: 'medium',
            timeStyle: 'short'
          })}
        </span>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={retry.isPending}
        onClick={() =>
          retry.mutate(posting.id, {
            onSuccess: () => toast.success(t('queued')),
            onError: error => toast.error(errorText(error))
          })
        }
      >
        {t('retry')}
      </Button>
    </li>
  )
}
