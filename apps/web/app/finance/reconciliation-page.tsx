'use client'

import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { ClientPermissions } from '@platform/core/auth'

import { BankImportsPanel } from '../../components/finance/bank-imports-panel'
import { BankProfilesPanel } from '../../components/finance/bank-profiles-panel'
import { BankStatusPanel } from '../../components/finance/bank-status-panel'
import { SelectField } from '../../components/finance/fields'
import { FinanceGate } from '../../components/finance/finance-gate'
import { useStore } from '../../components/providers/store-context'
import { LoadFailed, PageLoading, PermissionDenied } from '../../components/settings/states'
import { bankAccountsOf } from '../../lib/finance/bank-statement'
import { useFinanceAccounts } from '../../lib/finance/use-finance'

// Finance → Bank reconciliation (TDD_18 §4.4): the statement of a bank account, imported from its CSV, against the books. The rules suggest
// the pairs and a person confirms or rejects each one: nothing is reconciled by itself. Every route asks for finance:reconcile, and the
// accounts to choose from are read with finance:view (the api's own permission for the chart), so the page asks for both.
export function ReconciliationPage(): ReactElement {
  const { can } = useStore()
  if (!can(ClientPermissions.FINANCE_RECONCILE)) {
    return <PermissionDenied permission={ClientPermissions.FINANCE_RECONCILE} />
  }
  return <FinanceGate>{() => <Reconciliation />}</FinanceGate>
}

function Reconciliation(): ReactElement {
  const t = useTranslations('finance.reconciliation')
  const { storeId } = useStore()
  const accounts = useFinanceAccounts(storeId, true)
  const [chosen, setChosen] = useState('')

  if (accounts.isError) {
    return <LoadFailed error={accounts.error} onRetry={() => void accounts.refetch()} />
  }
  if (accounts.data === undefined) return <PageLoading />

  // Only the accounts the api takes a statement for (cash, bank or wallet) that post and are on; the chosen one stays in the list
  const candidates = bankAccountsOf(accounts.data, chosen === '' ? [] : [chosen])
  const accountId = candidates.some(account => account.id === chosen)
    ? chosen
    : (candidates[0]?.id ?? '')

  return (
    <section className="flex max-w-4xl flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
      </header>
      {candidates.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-testid="bank-no-accounts">
          {t('noAccounts')}
        </p>
      ) : (
        <>
          <div className="max-w-sm" data-testid="bank-account-picker">
            <SelectField
              label={t('account')}
              value={accountId}
              hint={t('accountHint')}
              onChange={setChosen}
            >
              {candidates.map(account => (
                <option key={account.id} value={account.id}>
                  {`${account.code} ${account.name}`}
                </option>
              ))}
            </SelectField>
          </div>
          <BankStatusPanel key={`status-${accountId}`} accountId={accountId} />
          <BankImportsPanel
            key={`imports-${accountId}`}
            accountId={accountId}
            accounts={accounts.data}
          />
          <BankProfilesPanel key={`profiles-${accountId}`} accountId={accountId} />
        </>
      )}
    </section>
  )
}
