'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { ClientPermissions } from '@platform/core/auth'

import { FinanceGate } from '../../components/finance/finance-gate'
import { MarginPanel } from '../../components/finance/margin-panel'
import { useStore } from '../../components/providers/store-context'
import { PermissionDenied } from '../../components/settings/states'

// Finance → Margin (TDD_18 §10): what each product earned in a range of days, by store, against the revenue and the cost of goods the
// ledger holds. The api asks finance:view_reports, and finance:export to take the file. It only reads the books.
export function MarginPage(): ReactElement {
  return <FinanceGate>{settings => <Margin lockedThrough={settings.lockedThrough} />}</FinanceGate>
}

function Margin({ lockedThrough }: { lockedThrough: string | null }): ReactElement {
  const t = useTranslations('finance.margin')
  const { can } = useStore()
  if (!can(ClientPermissions.FINANCE_VIEW_REPORTS)) {
    return <PermissionDenied permission={ClientPermissions.FINANCE_VIEW_REPORTS} />
  }
  return (
    <section className="flex max-w-5xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
      </header>
      <MarginPanel lockedThrough={lockedThrough} />
    </section>
  )
}
