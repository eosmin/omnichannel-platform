'use client'

import { Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, useMemo, useState } from 'react'

import type { FinanceAccountView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'

import { AccountDialog } from '../../components/finance/account-dialog'
import { FinanceGate } from '../../components/finance/finance-gate'
import { useStore } from '../../components/providers/store-context'
import { LoadFailed, PageLoading } from '../../components/settings/states'
import { Button } from '../../components/ui/button'
import { accountRowsOf } from '../../lib/finance/account-form'
import {
  useFinanceAccounts,
  useFinanceBalances,
  useSetFinanceAccountActive
} from '../../lib/finance/use-finance'
import { useMoney } from '../../lib/finance/use-money'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'

// Finance → Accounts (TDD_18 §3, §12): the chart of the organization, each account under its header, with its balance across all the
// periods. Reading is finance:view and changing finance:manage_accounts (the api checks both on every call).
export function AccountsPage(): ReactElement {
  return <FinanceGate>{() => <Accounts />}</FinanceGate>
}

function Accounts(): ReactElement {
  const t = useTranslations('finance.accounts')
  const { storeId, can } = useStore()
  const canManage = can(ClientPermissions.FINANCE_MANAGE_ACCOUNTS)
  const accounts = useFinanceAccounts(storeId, true)
  const balances = useFinanceBalances(storeId, null, true)
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const rows = useMemo(() => accountRowsOf(accounts.data ?? []), [accounts.data])
  const balanceOf = useMemo(
    () => new Map((balances.data ?? []).map(item => [item.accountId, item.balanceCents])),
    [balances.data]
  )
  if (accounts.isError) {
    return <LoadFailed error={accounts.error} onRetry={() => void accounts.refetch()} />
  }
  if (accounts.data === undefined) return <PageLoading />
  const editing = accounts.data.find(item => item.id === editingId) ?? null
  return (
    <section className="flex max-w-4xl flex-col gap-4">
      <header className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('description')}</p>
        </div>
        {canManage ? (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus aria-hidden />
            {t('new')}
          </Button>
        ) : null}
      </header>
      {balances.isError ? (
        <p className="text-muted-foreground text-sm">{t('balancesFailed')}</p>
      ) : null}
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : (
        <ul className="divide-y rounded-md border" data-testid="finance-accounts">
          {rows.map(({ account, depth }) => (
            <AccountRow
              key={account.id}
              account={account}
              depth={depth}
              balance={balanceOf.get(account.id) ?? null}
              canManage={canManage}
              onEdit={() => setEditingId(account.id)}
            />
          ))}
        </ul>
      )}
      <AccountDialog
        account={null}
        accounts={accounts.data}
        open={creating}
        onOpenChange={setCreating}
      />
      <AccountDialog
        account={editing}
        accounts={accounts.data}
        open={editing !== null}
        onOpenChange={open => {
          if (!open) setEditingId(null)
        }}
      />
    </section>
  )
}

function AccountRow({
  account,
  depth,
  balance,
  canManage,
  onEdit
}: {
  account: FinanceAccountView
  depth: number
  balance: string | null
  canManage: boolean
  onEdit: () => void
}): ReactElement {
  const t = useTranslations('finance.accounts')
  const money = useMoney()
  const errorText = useErrorText()
  const { storeId } = useStore()
  const toggle = useSetFinanceAccountActive(storeId)
  const change = (): void => {
    toggle.mutate(
      { id: account.id, active: !account.active },
      {
        onSuccess: () => toast.success(account.active ? t('deactivated') : t('reactivated')),
        onError: error => toast.error(errorText(error))
      }
    )
  }
  return (
    <li
      data-testid="finance-account-row"
      data-code={account.code}
      className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <div
        className="flex min-w-0 flex-col gap-0.5"
        style={{ paddingInlineStart: `${depth * 16}px` }}
      >
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-xs tabular-nums">{account.code}</span>
          <span className={account.isPostable ? 'font-medium' : 'font-semibold'}>
            {account.name}
          </span>
          {account.isPostable ? null : <Badge>{t('badges.header')}</Badge>}
          {account.isSystem ? <Badge>{t('badges.system')}</Badge> : null}
          {account.active ? null : <Badge>{t('badges.inactive')}</Badge>}
        </span>
        <span className="text-muted-foreground text-xs">
          {t(`types.${account.type as 'asset'}`)}
          {account.cashKind === null ? '' : ` · ${t(`cashKinds.${account.cashKind as 'cash'}`)}`}
        </span>
      </div>
      <div className="flex items-center justify-between gap-3 sm:justify-end">
        {balance === null || !account.isPostable ? null : (
          <span className="text-sm tabular-nums" data-testid="finance-account-balance">
            {money(balance)}
          </span>
        )}
        {canManage ? (
          <span className="flex gap-1">
            <Button type="button" size="sm" variant="outline" onClick={onEdit}>
              {t('edit')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={toggle.isPending}
              onClick={change}
            >
              {account.active ? t('deactivate') : t('reactivate')}
            </Button>
          </span>
        ) : null}
      </div>
    </li>
  )
}

function Badge({ children }: { children: string }): ReactElement {
  return (
    <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs">
      {children}
    </span>
  )
}
