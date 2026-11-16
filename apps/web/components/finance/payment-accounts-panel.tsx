'use client'

import { useTranslations } from 'next-intl'
import { type ReactElement } from 'react'

import type { FinancePaymentAccountView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { FinancePaymentMethods } from '@platform/core/domain'

import { cashAccountsOf } from '../../lib/finance/account-form'
import {
  useFinanceAccounts,
  useFinancePaymentAccounts,
  useRemoveFinancePaymentAccount,
  useSetFinancePaymentAccount
} from '../../lib/finance/use-finance'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { LoadFailed, PageLoading } from '../settings/states'

import { SelectField } from './fields'

// The account the money of each payment method lands in (TDD_18 §3): one choice for the organization and, if a store keeps its own
// cash or bank, a choice of that store. A store with no choice of its own follows the organization.
export function PaymentAccountsPanel(): ReactElement {
  const t = useTranslations('finance.settings.payments')
  const errorText = useErrorText()
  const { storeId, storeName, can } = useStore()
  const canManage = can(ClientPermissions.FINANCE_MANAGE_ACCOUNTS)
  const payments = useFinancePaymentAccounts(storeId, true)
  const accounts = useFinanceAccounts(storeId, true)
  const set = useSetFinancePaymentAccount(storeId)
  const remove = useRemoveFinancePaymentAccount(storeId)
  const failed = payments.isError ? payments : accounts.isError ? accounts : null
  if (failed !== null) {
    return <LoadFailed error={failed.error} onRetry={() => void failed.refetch()} />
  }
  if (payments.data === undefined || accounts.data === undefined) return <PageLoading />
  const chart = accounts.data
  const rows = payments.data
  const find = (method: string, forStore: string | null): FinancePaymentAccountView | undefined =>
    rows.find(row => row.paymentMethod === method && row.storeId === forStore)
  const busy = set.isPending || remove.isPending
  const fail = (error: Error): void => {
    toast.error(errorText(error))
  }
  const choose = (method: string, forStore: string | null, accountId: string): void => {
    const own = find(method, forStore)
    if (accountId === (own?.accountId ?? '')) return
    if (accountId === '' && own !== undefined) {
      remove.mutate(own.id, { onSuccess: () => toast.success(t('saved')), onError: fail })
      return
    }
    if (accountId === '') return
    set.mutate(
      { paymentMethod: method, accountId, forStoreId: forStore },
      { onSuccess: () => toast.success(t('saved')), onError: fail }
    )
  }
  return (
    <section className="flex flex-col gap-3" aria-labelledby="finance-payments-title">
      <h2 id="finance-payments-title" className="text-lg font-semibold">
        {t('title')}
      </h2>
      <p className="text-muted-foreground text-sm">{t('description')}</p>
      <ul className="flex flex-col gap-4" data-testid="finance-payments">
        {/* The methods a book takes money in: cash on delivery is not one, it arrives through a remittance */}
        {FinancePaymentMethods.map(method => {
          const organization = find(method, null)
          const own = find(method, storeId)
          // What was just chosen shows at once, and goes back to what the books hold if the api refuses
          const shown = (forStore: string | null, held: string): string =>
            set.isPending &&
            set.variables?.paymentMethod === String(method) &&
            set.variables.forStoreId === forStore
              ? set.variables.accountId
              : held
          return (
            <li key={method} className="grid gap-3 sm:grid-cols-2" data-method={method}>
              <SelectField
                label={t('organization', { method: t(`methods.${method as 'CASH'}`) })}
                value={shown(null, organization?.accountId ?? '')}
                disabled={!canManage || busy}
                onChange={accountId => choose(method, null, accountId)}
              >
                {organization === undefined ? <option value="">{t('notChosen')}</option> : null}
                {cashAccountsOf(chart, [organization?.accountId ?? '']).map(account => (
                  <option key={account.id} value={account.id}>
                    {account.code} · {account.name}
                  </option>
                ))}
              </SelectField>
              <SelectField
                label={t('thisStore', {
                  method: t(`methods.${method as 'CASH'}`),
                  store: storeName
                })}
                value={shown(storeId, own?.accountId ?? '')}
                disabled={!canManage || busy}
                onChange={accountId => choose(method, storeId, accountId)}
              >
                <option value="">{t('followsOrganization')}</option>
                {cashAccountsOf(chart, [own?.accountId ?? '']).map(account => (
                  <option key={account.id} value={account.id}>
                    {account.code} · {account.name}
                  </option>
                ))}
              </SelectField>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
