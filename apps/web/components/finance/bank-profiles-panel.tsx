'use client'

import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import type { BankProfileView } from '@platform/api-client'

import { delimiterKey } from '../../lib/finance/bank-form'
import { useBankErrorText } from '../../lib/finance/use-bank-error-text'
import { useBankProfiles, useDeleteBankProfile } from '../../lib/finance/use-finance-bank'
import { toast } from '../../lib/toast'
import { useStore } from '../providers/store-context'
import { LoadFailed, PageLoading } from '../settings/states'
import { Button } from '../ui/button'

import { BankConfirmDialog } from './bank-confirm-dialog'
import { BankProfileDialog } from './bank-profile-dialog'

// The profiles of the account (TDD_18 §4.4): one for each bank file format the account receives. Making or changing one needs only the
// permission of the reconciliation; deleting one leaves the statements already imported with it as they are.
export function BankProfilesPanel({ accountId }: { accountId: string }): ReactElement {
  const t = useTranslations('finance.reconciliation.profiles')
  const options = useTranslations('finance.reconciliation.profiles.options')
  const errorText = useBankErrorText()
  const { storeId } = useStore()
  const profiles = useBankProfiles(storeId, accountId, true)
  const remove = useDeleteBankProfile(storeId)
  const [editing, setEditing] = useState<BankProfileView | 'new' | null>(null)
  const [removing, setRemoving] = useState<BankProfileView | null>(null)

  if (profiles.isError) {
    return <LoadFailed error={profiles.error} onRetry={() => void profiles.refetch()} />
  }
  if (profiles.data === undefined) return <PageLoading />

  return (
    <section className="flex flex-col gap-3" aria-labelledby="bank-profiles-title">
      <header className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="bank-profiles-title" className="text-lg font-semibold">
            {t('title')}
          </h2>
          <p className="text-muted-foreground text-sm">{t('description')}</p>
        </div>
        <Button size="sm" onClick={() => setEditing('new')}>
          <Plus aria-hidden />
          {t('new')}
        </Button>
      </header>
      {profiles.data.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-testid="bank-profiles-empty">
          {t('empty')}
        </p>
      ) : (
        <ul className="divide-y rounded-md border" data-testid="bank-profiles">
          {profiles.data.map(profile => (
            <li
              key={profile.id}
              data-testid="bank-profile-row"
              data-name={profile.name}
              className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate font-medium">{profile.name}</span>
                <span className="text-muted-foreground text-xs">
                  {t('summary', {
                    delimiter: options(`delimiter.${delimiterKey(profile.delimiter)}`),
                    encoding: profile.encoding,
                    days: profile.dateWindowDays
                  })}
                </span>
              </span>
              <span className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setEditing(profile)}
                  aria-label={t('editNamed', { name: profile.name })}
                >
                  <Pencil aria-hidden />
                  {t('edit')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setRemoving(profile)}
                  aria-label={t('deleteNamed', { name: profile.name })}
                >
                  <Trash2 aria-hidden />
                  {t('delete')}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <BankProfileDialog
        profile={editing === 'new' ? null : editing}
        accountId={accountId}
        open={editing !== null}
        onOpenChange={open => {
          if (!open) setEditing(null)
        }}
      />
      <BankConfirmDialog
        open={removing !== null}
        onOpenChange={open => {
          if (!open) setRemoving(null)
        }}
        title={t('deleteTitle', { name: removing?.name ?? '' })}
        description={t('deleteDescription')}
        confirmLabel={t('delete')}
        busy={remove.isPending}
        onConfirm={() => {
          if (removing === null) return
          remove.mutate(removing.id, {
            onSuccess: () => {
              toast.success(t('deleted'))
              setRemoving(null)
            },
            onError: error => {
              toast.error(errorText(error))
              setRemoving(null)
            }
          })
        }}
      />
    </section>
  )
}
