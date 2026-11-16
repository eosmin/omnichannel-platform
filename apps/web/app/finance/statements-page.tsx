'use client'

import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { ClientPermissions } from '@platform/core/auth'

import { BalanceSheetPanel } from '../../components/finance/balance-sheet-panel'
import { CashFlowPanel } from '../../components/finance/cash-flow-panel'
import { FinanceGate } from '../../components/finance/finance-gate'
import { IncomeStatementPanel } from '../../components/finance/income-statement-panel'
import { useStore } from '../../components/providers/store-context'
import { PermissionDenied } from '../../components/settings/states'
import { Tabs, TabsList, TabsTrigger } from '../../components/ui/tabs'

const StatementTabs = {
  INCOME: 'income',
  BALANCE: 'balance',
  CASH: 'cash'
} as const
type StatementTab = (typeof StatementTabs)[keyof typeof StatementTabs]

// Finance → Statements (TDD_18 §10): the income statement and the cash flow of a range of days and the balance sheet of a day, each as it
// is on screen and as the file the api writes. They only read the ledger. The api asks for finance:view_reports, and for finance:export
// to take a file, which is the only thing that permission hides here.
export function StatementsPage(): ReactElement {
  return (
    <FinanceGate>{settings => <Statements lockedThrough={settings.lockedThrough} />}</FinanceGate>
  )
}

function Statements({ lockedThrough }: { lockedThrough: string | null }): ReactElement {
  const t = useTranslations('finance.statements')
  const { can } = useStore()
  const [tab, setTab] = useState<StatementTab>(StatementTabs.INCOME)
  if (!can(ClientPermissions.FINANCE_VIEW_REPORTS)) {
    return <PermissionDenied permission={ClientPermissions.FINANCE_VIEW_REPORTS} />
  }
  return (
    <section className="flex max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
      </header>
      <Tabs value={tab} onValueChange={value => setTab(value as StatementTab)}>
        <TabsList aria-label={t('tabsLabel')} className="h-auto max-w-full flex-wrap">
          {Object.values(StatementTabs).map(value => (
            <TabsTrigger key={value} value={value} data-testid={`finance-statement-tab-${value}`}>
              {t(`tabs.${value}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {tab === StatementTabs.INCOME ? <IncomeStatementPanel lockedThrough={lockedThrough} /> : null}
      {tab === StatementTabs.BALANCE ? <BalanceSheetPanel lockedThrough={lockedThrough} /> : null}
      {tab === StatementTabs.CASH ? <CashFlowPanel lockedThrough={lockedThrough} /> : null}
    </section>
  )
}
