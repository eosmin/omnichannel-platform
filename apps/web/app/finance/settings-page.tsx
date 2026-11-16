'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import type { FinanceSettingsView } from '@platform/api-client'

import { FinanceGate } from '../../components/finance/finance-gate'
import { PaymentAccountsPanel } from '../../components/finance/payment-accounts-panel'
import { PostingSettingsLoader } from '../../components/finance/posting-settings-loader'
import { RoleMapPanel } from '../../components/finance/role-map-panel'
import { StoreTaxPanel } from '../../components/finance/store-tax-panel'

// Finance → Settings (TDD_18 §3, §7): how the books post, which account each role and payment method uses, and the tax preference
// of this store. Everything here is read with finance:view and changed with finance:manage_accounts. Each panel reads what it needs, so
// they all ask at once and none waits for another.
export function FinanceSettingsPage(): ReactElement {
  return <FinanceGate>{settings => <FinanceSettings settings={settings} />}</FinanceGate>
}

function FinanceSettings({ settings }: { settings: FinanceSettingsView }): ReactElement {
  const t = useTranslations('finance.settings')
  return (
    <section className="flex max-w-3xl flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
      </header>
      <PostingSettingsLoader settings={settings} />
      <RoleMapPanel />
      <PaymentAccountsPanel />
      <StoreTaxPanel />
    </section>
  )
}
