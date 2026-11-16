'use client'

import { useTranslations } from 'next-intl'
import { type ReactElement, useMemo } from 'react'

import type { FinanceAccountView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { AccountRole, CashKind } from '@platform/core/domain'

import { cashAccountsOf, postableAccountsOf } from '../../lib/finance/account-form'
import {
  useFinanceAccounts,
  useFinanceRoles,
  useMapFinanceRole
} from '../../lib/finance/use-finance'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { LoadFailed, PageLoading } from '../settings/states'

import { SelectField } from './fields'

// The account each role of the books posts to (TDD_18 §3, §4.2): the sales, the tax, the stock, what is owed to suppliers. A role
// with no account stops the entries that need it, and says so in the postings that failed. A choice is saved when it is made.
// Cash and the bank of the books are accounts of that kind of money; the other roles take any account that posts. (Whether a role may
// take an account of a given type is the api's rule: it answers with a code that is said as it is.)
const CASH_KIND_OF_ROLE: Readonly<Partial<Record<string, string>>> = {
  [AccountRole.CASH_DEFAULT]: CashKind.CASH,
  [AccountRole.BANK_DEFAULT]: CashKind.BANK
}

function optionsOf(
  role: string,
  accounts: readonly FinanceAccountView[],
  current: string
): FinanceAccountView[] {
  const kind = CASH_KIND_OF_ROLE[role]
  return kind === undefined
    ? postableAccountsOf(accounts, [current])
    : cashAccountsOf(accounts, [current], [kind])
}

export function RoleMapPanel(): ReactElement {
  const t = useTranslations('finance.settings.roles')
  const errorText = useErrorText()
  const { storeId, can } = useStore()
  const canManage = can(ClientPermissions.FINANCE_MANAGE_ACCOUNTS)
  const roles = useFinanceRoles(storeId, true)
  const accounts = useFinanceAccounts(storeId, true)
  const map = useMapFinanceRole(storeId)
  const mapped = useMemo(
    () => new Map((roles.data ?? []).map(item => [item.role, item.accountId])),
    [roles.data]
  )
  const failed = roles.isError ? roles : accounts.isError ? accounts : null
  if (failed !== null)
    return <LoadFailed error={failed.error} onRetry={() => void failed.refetch()} />
  if (roles.data === undefined || accounts.data === undefined) return <PageLoading />
  return (
    <section className="flex flex-col gap-3" aria-labelledby="finance-roles-title">
      <h2 id="finance-roles-title" className="text-lg font-semibold">
        {t('title')}
      </h2>
      <p className="text-muted-foreground text-sm">{t('description')}</p>
      <div className="grid gap-3 sm:grid-cols-2" data-testid="finance-roles">
        {Object.values(AccountRole).map(role => {
          // What was just chosen shows at once, and goes back to what the books hold if the api refuses
          const current =
            map.isPending && map.variables?.role === String(role)
              ? map.variables.accountId
              : (mapped.get(role) ?? '')
          return (
            <SelectField
              key={role}
              label={t(`names.${role}`)}
              value={current}
              disabled={!canManage || map.isPending}
              onChange={accountId => {
                if (accountId === '' || accountId === current) return
                map.mutate(
                  { role, accountId },
                  {
                    onSuccess: () => toast.success(t('saved', { role: t(`names.${role}`) })),
                    onError: error => toast.error(errorText(error))
                  }
                )
              }}
            >
              {current === '' ? <option value="">{t('notMapped')}</option> : null}
              {optionsOf(role, accounts.data, current).map(account => (
                <option key={account.id} value={account.id}>
                  {account.code} · {account.name}
                </option>
              ))}
            </SelectField>
          )
        })}
      </div>
    </section>
  )
}
