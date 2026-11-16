'use client'

import { Plus } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import type { FinancePeriodView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { PeriodStatus } from '@platform/core/domain'

import { FinanceGate } from '../../components/finance/finance-gate'
import { OpenPeriodDialog } from '../../components/finance/open-period-dialog'
import { PostingsPanel } from '../../components/finance/postings-panel'
import { useStore } from '../../components/providers/store-context'
import { LoadFailed, PageLoading } from '../../components/settings/states'
import { Button } from '../../components/ui/button'
import { useFinancePeriods } from '../../lib/finance/use-finance'

// Finance → Periods (TDD_18 §3): the months of the books and whether each is open. Closing and reopening a month is Step 4B.8's
// route and its screen is 4B.9b; here a period is read and opened ahead of time. The postings that failed are here too, for who
// manages the accounts (the api asks for that permission to list them).
export function PeriodsPage(): ReactElement {
  return <FinanceGate>{settings => <Periods lockedThrough={settings.lockedThrough} />}</FinanceGate>
}

function Periods({ lockedThrough }: { lockedThrough: string | null }): ReactElement {
  const t = useTranslations('finance.periods')
  const { storeId, can } = useStore()
  const canManage = can(ClientPermissions.FINANCE_MANAGE_ACCOUNTS)
  const periods = useFinancePeriods(storeId, true)
  const [opening, setOpening] = useState(false)
  if (periods.isError) {
    return <LoadFailed error={periods.error} onRetry={() => void periods.refetch()} />
  }
  if (periods.data === undefined) return <PageLoading />
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
              <PeriodRow key={period.id} period={period} />
            ))}
          </ul>
        )}
      </div>
      {canManage ? <PostingsPanel /> : null}
      <OpenPeriodDialog open={opening} onOpenChange={setOpening} />
    </section>
  )
}

function PeriodRow({ period }: { period: FinancePeriodView }): ReactElement {
  const t = useTranslations('finance.periods')
  const format = useFormatter()
  // A month is a calendar month, not an instant: it is written from its own day in UTC, so no zone moves it to the next one
  const month = format.dateTime(new Date(Date.UTC(period.year, period.month - 1, 1)), {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC'
  })
  const closed = period.status === String(PeriodStatus.CLOSED)
  return (
    <li
      data-testid="finance-period-row"
      data-period={`${String(period.year)}-${String(period.month).padStart(2, '0')}`}
      className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <span className="flex flex-col gap-0.5">
        <span className="font-medium capitalize">{month}</span>
        <span className="text-muted-foreground text-xs">
          {period.startsOn} – {period.endsOn}
        </span>
      </span>
      <span className="flex flex-col items-start gap-0.5 sm:items-end">
        <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs">
          {closed ? t('status.closed') : t('status.open')}
        </span>
        {period.reopenReason === null ? null : (
          <span className="text-muted-foreground text-xs">
            {t('reopenReason', { reason: period.reopenReason })}
          </span>
        )}
      </span>
    </li>
  )
}
