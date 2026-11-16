'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { ClientPermissions } from '@platform/core/auth'

import { AgingPanel } from '../../components/finance/aging-panel'
import { FinanceGate } from '../../components/finance/finance-gate'
import { useStore } from '../../components/providers/store-context'
import { PermissionDenied } from '../../components/settings/states'

// Finance → Aging (TDD_18 §10): what is owed to the business (by the carriers) and what the business owes (to suppliers and carriers), by
// the age of each balance, as of a day. It only reads the ledger: finance:view_reports, and finance:export for the file.
export function AgingPage(): ReactElement {
  return <FinanceGate>{settings => <Aging lockedThrough={settings.lockedThrough} />}</FinanceGate>
}

function Aging({ lockedThrough }: { lockedThrough: string | null }): ReactElement {
  const t = useTranslations('finance.aging')
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
      <AgingPanel lockedThrough={lockedThrough} />
    </section>
  )
}
