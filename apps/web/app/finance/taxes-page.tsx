'use client'

import { Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, useMemo, useState } from 'react'

import type { FinanceAccountView, FinanceTaxRateView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'

import { FinanceGate } from '../../components/finance/finance-gate'
import { TaxRateDialog } from '../../components/finance/tax-rate-dialog'
import { TaxRateToggleDialog } from '../../components/finance/tax-rate-toggle-dialog'
import { useStore } from '../../components/providers/store-context'
import { LoadFailed, PageLoading } from '../../components/settings/states'
import { Button } from '../../components/ui/button'
import {
  useFinanceAccounts,
  useFinanceTaxRates,
  useSetFinanceTaxRateActive,
  useUpdateFinanceTaxRate
} from '../../lib/finance/use-finance'
import { usePercentFigure } from '../../lib/finance/use-money'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'

// Finance → Taxes (TDD_18 §7): the rates of the organization, which one is the default and the accounts each posts to.
export function TaxesPage(): ReactElement {
  return <FinanceGate>{() => <Taxes />}</FinanceGate>
}

function Taxes(): ReactElement {
  const t = useTranslations('finance.taxes')
  const { storeId, can } = useStore()
  const canManage = can(ClientPermissions.FINANCE_MANAGE_ACCOUNTS)
  const rates = useFinanceTaxRates(storeId, true)
  const accounts = useFinanceAccounts(storeId, true)
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const codeOf = useMemo(
    () => new Map((accounts.data ?? []).map(account => [account.id, account.code])),
    [accounts.data]
  )
  const failed = rates.isError ? rates : accounts.isError ? accounts : null
  if (failed !== null) {
    return <LoadFailed error={failed.error} onRetry={() => void failed.refetch()} />
  }
  if (rates.data === undefined || accounts.data === undefined) return <PageLoading />
  const editing = rates.data.find(item => item.id === editingId) ?? null
  return (
    <section className="flex max-w-3xl flex-col gap-4">
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
      {rates.data.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : (
        <ul className="divide-y rounded-md border" data-testid="finance-tax-rates">
          {rates.data.map(rate => (
            <TaxRateRow
              key={rate.id}
              rate={rate}
              accountCodes={codeOf}
              canManage={canManage}
              onEdit={() => setEditingId(rate.id)}
            />
          ))}
        </ul>
      )}
      <TaxRateDialog
        rate={null}
        accounts={accounts.data}
        open={creating}
        onOpenChange={setCreating}
      />
      <TaxRateDialog
        rate={editing}
        accounts={accounts.data}
        open={editing !== null}
        onOpenChange={open => {
          if (!open) setEditingId(null)
        }}
      />
    </section>
  )
}

function TaxRateRow({
  rate,
  accountCodes,
  canManage,
  onEdit
}: {
  rate: FinanceTaxRateView
  accountCodes: ReadonlyMap<FinanceAccountView['id'], string>
  canManage: boolean
  onEdit: () => void
}): ReactElement {
  const t = useTranslations('finance.taxes')
  const percentFigure = usePercentFigure()
  const errorText = useErrorText()
  const { storeId } = useStore()
  const toggle = useSetFinanceTaxRateActive(storeId)
  const makeDefault = useUpdateFinanceTaxRate(storeId)
  const busy = toggle.isPending || makeDefault.isPending
  // What the question asks is kept after it closes, so its text does not flip while it fades out and the rate is read again
  const [toggling, setToggling] = useState<{ open: boolean; turningOn: boolean }>({
    open: false,
    turningOn: false
  })
  const closeToggle = (): void => setToggling(current => ({ ...current, open: false }))
  const fail = (error: Error): void => {
    toast.error(errorText(error))
  }
  return (
    <li
      data-testid="finance-tax-rate-row"
      data-code={rate.code}
      className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{rate.name}</span>
          <span className="text-muted-foreground text-xs">{rate.code}</span>
          {rate.isDefault ? (
            <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs">
              {t('badges.default')}
            </span>
          ) : null}
          {rate.active ? null : (
            <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs">
              {t('badges.inactive')}
            </span>
          )}
        </span>
        <span className="text-sm tabular-nums" data-testid="finance-tax-rate-percent">
          {t('percent', { percent: percentFigure(rate.rateBps) })}
        </span>
        <span className="text-muted-foreground text-xs">
          {t('accounts', {
            output: accountCodes.get(rate.outputAccountId) ?? t('noAccount'),
            input: accountCodes.get(rate.inputAccountId) ?? t('noAccount')
          })}
        </span>
      </div>
      {canManage ? (
        <span className="flex flex-wrap gap-1">
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onEdit}>
            {t('edit')}
          </Button>
          {rate.active && !rate.isDefault ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                makeDefault.mutate(
                  { id: rate.id, changes: { isDefault: true } },
                  {
                    onSuccess: () => toast.success(t('madeDefault', { name: rate.name })),
                    onError: fail
                  }
                )
              }
            >
              {t('makeDefault')}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setToggling({ open: true, turningOn: !rate.active })}
          >
            {rate.active ? t('deactivate') : t('reactivate')}
          </Button>
        </span>
      ) : null}
      <TaxRateToggleDialog
        open={toggling.open}
        onOpenChange={open => {
          if (!open) closeToggle()
        }}
        name={rate.name}
        turningOn={toggling.turningOn}
        busy={toggle.isPending}
        onConfirm={() =>
          toggle.mutate(
            { id: rate.id, active: !rate.active },
            {
              onSuccess: () => {
                closeToggle()
                toast.success(rate.active ? t('deactivated') : t('reactivated'))
              },
              onError: error => {
                closeToggle()
                fail(error)
              }
            }
          )
        }
      />
    </li>
  )
}
