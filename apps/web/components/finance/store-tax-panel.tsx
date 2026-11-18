'use client'

import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { ClientPermissions } from '@platform/core/auth'

import { useFinanceStoreTax, useUpdateFinanceStoreTax } from '../../lib/finance/use-finance'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { LoadFailed, PageLoading } from '../settings/states'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../ui/alert-dialog'

// Whether the prices of the catalog of THIS store already include the tax (TDD_18 §7): the only tax setting that belongs to a store
// and not to the organization. It is saved when it is changed.
export function StoreTaxPanel(): ReactElement {
  const t = useTranslations('finance.settings.storeTax')
  const errorText = useErrorText()
  const { storeId, can } = useStore()
  const canManage = can(ClientPermissions.FINANCE_MANAGE_ACCOUNTS)
  const tax = useFinanceStoreTax(storeId, true)
  const update = useUpdateFinanceStoreTax(storeId)
  // The mode a person asked for and has not confirmed: the same catalog totals another amount in the other mode (HC-209)
  const [pending, setPending] = useState<boolean | null>(null)
  if (tax.isError) return <LoadFailed error={tax.error} onRetry={() => void tax.refetch()} />
  if (tax.data === undefined) return <PageLoading />
  return (
    <section className="flex flex-col gap-3" aria-labelledby="finance-store-tax-title">
      <h2 id="finance-store-tax-title" className="text-lg font-semibold">
        {t('title')}
      </h2>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          // What was just chosen shows at once; it goes back to what the books hold if the api refuses
          checked={
            update.isPending
              ? (update.variables?.pricesIncludeTax ?? tax.data.pricesIncludeTax)
              : tax.data.pricesIncludeTax
          }
          disabled={!canManage || update.isPending}
          onChange={event => setPending(event.target.checked)}
        />
        <span>
          {t('pricesIncludeTax')}
          <span className="text-muted-foreground block text-xs">{t('pricesIncludeTaxHint')}</span>
        </span>
      </label>
      <AlertDialog
        open={pending !== null}
        onOpenChange={open => (open ? undefined : setPending(null))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('confirmDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('confirmCancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pending === null) return
                update.mutate(
                  { pricesIncludeTax: pending, confirmPriceModeChange: true },
                  {
                    onSuccess: () => toast.success(t('saved')),
                    onError: error => toast.error(errorText(error))
                  }
                )
                setPending(null)
              }}
            >
              {t('confirmAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
