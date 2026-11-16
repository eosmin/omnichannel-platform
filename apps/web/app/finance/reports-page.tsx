'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { ClientPermissions } from '@platform/core/auth'

import { ChainIncidentNotice } from '../../components/finance/chain-incident-notice'
import { ChainPanel } from '../../components/finance/chain-panel'
import { FinanceGate } from '../../components/finance/finance-gate'
import { JournalExportPanel } from '../../components/finance/journal-export-panel'
import { LedgerPanel } from '../../components/finance/ledger-panel'
import { TrialBalancePanel } from '../../components/finance/trial-balance-panel'
import { useStore } from '../../components/providers/store-context'

// Finance → Reports (TDD_18 §10, §11): the trial balance of a month, the ledger of an account, the files an auditor takes out and the
// check of the chain. Each section is drawn only for who holds the permission the api asks for it: the trial balance for
// finance:view, the ledger for finance:view_journal, the file of the journal for both finance:view_journal and finance:export, the
// check of the chain for finance:export.
export function ReportsPage(): ReactElement {
  return <FinanceGate>{() => <Reports />}</FinanceGate>
}

function Reports(): ReactElement {
  const t = useTranslations('finance.reports')
  const { can } = useStore()
  const canJournal = can(ClientPermissions.FINANCE_VIEW_JOURNAL)
  const canExport = can(ClientPermissions.FINANCE_EXPORT)
  return (
    <section className="flex max-w-4xl flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
      </header>
      <ChainIncidentNotice />
      <TrialBalancePanel />
      {canJournal ? <LedgerPanel /> : null}
      {canJournal && canExport ? <JournalExportPanel /> : null}
      {canExport ? <ChainPanel /> : null}
    </section>
  )
}
