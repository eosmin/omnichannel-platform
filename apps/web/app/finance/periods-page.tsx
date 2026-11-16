'use client'

import { Lock, LockOpen, Plus } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import type { FinancePeriodView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { PeriodStatus } from '@platform/core/domain'

import { ClosePeriodDialog } from '../../components/finance/close-period-dialog'
import { FinanceGate } from '../../components/finance/finance-gate'
import { OpenPeriodDialog } from '../../components/finance/open-period-dialog'
import { PostingsPanel } from '../../components/finance/postings-panel'
import { ReopenPeriodDialog } from '../../components/finance/reopen-period-dialog'
import { useStore } from '../../components/providers/store-context'
import { LoadFailed, PageLoading } from '../../components/settings/states'
import { Button } from '../../components/ui/button'
import { periodHasEnded, periodKeyOf } from '../../lib/finance/period-form'
import { useFinancePeriods } from '../../lib/finance/use-finance'

// Finance → Periods (TDD_18 §3, §5): the months of the books and whether each is open. A period is opened ahead of time (who manages
// the accounts), closed, and reopened if it is the latest closed one (who holds finance:close_periods); both ask first and say what
// they do. The postings that failed are here too, for who manages the accounts (the api asks for that permission to list them).
export function PeriodsPage(): ReactElement {
  return <FinanceGate>{settings => <Periods lockedThrough={settings.lockedThrough} />}</FinanceGate>
}

function Periods({ lockedThrough }: { lockedThrough: string | null }): ReactElement {
  const t = useTranslations('finance.periods')
  const { storeId, can } = useStore()
  const canManage = can(ClientPermissions.FINANCE_MANAGE_ACCOUNTS)
  const canClose = can(ClientPermissions.FINANCE_CLOSE_PERIODS)
  const periods = useFinancePeriods(storeId, true)
  const [opening, setOpening] = useState(false)
  if (periods.isError) {
    return <LoadFailed error={periods.error} onRetry={() => void periods.refetch()} />
  }
  if (periods.data === undefined) return <PageLoading />
  // Only the latest closed month can be reopened (the api says the same)
  const latestClosed = periods.data
    .filter(period => period.status === String(PeriodStatus.CLOSED))
    .map(periodKeyOf)
    .sort()
    .at(-1)
  return (
    <section className="flex max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-4">
        <header className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold">{t('title')}</h1>
            <p className="text-muted-foreground text-sm">{t('description')}</p>
            {lockedThrough === null ? null : (
              <p className="text-sm" data-testid="finance-locked-through">
                {t('lockedThrough', { date: lockedThrough })}
              </p>
            )}
          </div>
          {canManage ? (
            <Button size="sm" onClick={() => setOpening(true)}>
              <Plus aria-hidden />
              {t('open.action')}
            </Button>
          ) : null}
        </header>
        {periods.data.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('empty')}</p>
        ) : (
          <ul className="divide-y rounded-md border" data-testid="finance-periods">
            {periods.data.map(period => (
              <PeriodRow
                key={period.id}
                period={period}
                canClose={canClose}
                isLatestClosed={periodKeyOf(period) === latestClosed}
              />
            ))}
          </ul>
        )}
      </div>
      {canManage ? <PostingsPanel /> : null}
      <OpenPeriodDialog open={opening} onOpenChange={setOpening} />
    </section>
  )
}

function PeriodRow({
  period,
  canClose,
  isLatestClosed
}: {
  period: FinancePeriodView
  canClose: boolean
  isLatestClosed: boolean
}): ReactElement {
  const t = useTranslations('finance.periods')
  const format = useFormatter()
  const [asking, setAsking] = useState<'close' | 'reopen' | null>(null)
  // A month is a calendar month, not an instant: it is written from its own day in UTC, so no zone moves it to the next one
  const month = format.dateTime(new Date(Date.UTC(period.year, period.month - 1, 1)), {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC'
  })
  const closed = period.status === String(PeriodStatus.CLOSED)
  // A day is written in the language of the person, from its own date and not through a zone that could move it
  const day = (text: string): string =>
    format.dateTime(new Date(`${text}T00:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' })
  return (
    <li
      data-testid="finance-period-row"
      data-period={periodKeyOf(period)}
      className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <span className="flex flex-col gap-0.5">
        <span className="font-medium capitalize">{month}</span>
        <span className="text-muted-foreground text-xs">
          {day(period.startsOn)} – {day(period.endsOn)}
        </span>
      </span>
      <span className="flex flex-col items-start gap-0.5 sm:items-end">
        <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs">
          {closed ? t('status.closed') : t('status.open')}
        </span>
        {closed && period.closedAt !== null ? (
          <span className="text-muted-foreground text-xs">
            {t('closedOn', {
              date: format.dateTime(new Date(period.closedAt), { dateStyle: 'medium' })
            })}
          </span>
        ) : null}
        {period.reopenReason === null ? null : (
          <span className="text-muted-foreground text-xs">
            {t('reopenReason', { reason: period.reopenReason })}
          </span>
        )}
        {canClose && !closed && periodHasEnded(period, new Date()) ? (
          <Button
            size="sm"
            variant="outline"
            data-testid="finance-period-close"
            aria-label={t('close.action', { month })}
            onClick={() => setAsking('close')}
          >
            <Lock aria-hidden />
            {t('close.submitShort')}
          </Button>
        ) : null}
        {canClose && closed && isLatestClosed ? (
          <Button
            size="sm"
            variant="outline"
            data-testid="finance-period-reopen"
            aria-label={t('reopen.action', { month })}
            onClick={() => setAsking('reopen')}
          >
            <LockOpen aria-hidden />
            {t('reopen.submitShort')}
          </Button>
        ) : null}
      </span>
      <ClosePeriodDialog
        period={period}
        endsOnText={day(period.endsOn)}
        open={asking === 'close'}
        onOpenChange={next => setAsking(next ? 'close' : null)}
      />
      <ReopenPeriodDialog
        period={period}
        open={asking === 'reopen'}
        onOpenChange={next => setAsking(next ? 'reopen' : null)}
      />
    </li>
  )
}
