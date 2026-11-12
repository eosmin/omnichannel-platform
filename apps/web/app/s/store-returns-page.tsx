'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useState } from 'react'

import { ClientPermissions } from '@platform/core/auth'
import { ShippingPayer } from '@platform/core/domain'

import { useStore } from '../../components/providers/store-context'
import { LoadFailed, PageLoading, PermissionDenied } from '../../components/settings/states'
import { Button } from '../../components/ui/button'
import type { ReturnSettingsView } from '../../lib/settings/return-settings-requests'
import { useUnsavedChanges } from '../../lib/settings/unsaved-changes'
import { useReturnSettings, useSaveReturnSettings } from '../../lib/settings/use-return-settings'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'

const PAYERS = [ShippingPayer.SENDER, ShippingPayer.RECIPIENT] as const

// Settings → Returns (TDD_17 §4.11, §4.14): who pays the way back of a return, and the shipping of a replacement, when
// the return itself does not say. Opening needs SETTINGS_VIEW and saving SETTINGS_EDIT, as the api asks. A change never
// touches a return that exists: each one keeps the payer it was made with.
export function StoreReturnsPage(): ReactElement {
  const { can } = useStore()
  return can(ClientPermissions.SETTINGS_VIEW) ? (
    <ReturnsLoader />
  ) : (
    <PermissionDenied permission={ClientPermissions.SETTINGS_VIEW} />
  )
}

function ReturnsLoader(): ReactElement {
  const t = useTranslations('settings.returns')
  const { storeId } = useStore()
  const settings = useReturnSettings(storeId)
  if (settings.isError) {
    return <LoadFailed error={settings.error} onRetry={() => void settings.refetch()} />
  }
  if (settings.data === undefined) return <PageLoading />
  return (
    <section className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
      </header>
      <ReturnsForm key={storeId} saved={settings.data} />
    </section>
  )
}

// `saved` is what the form started from and, after a save of its own, what that save returned: another person's change
// that a later read brings does not move it
function ReturnsForm({ saved: loaded }: { saved: ReturnSettingsView }): ReactElement {
  const [saved, setSaved] = useState(loaded)
  const t = useTranslations('settings.returns')
  const errorText = useErrorText()
  const { storeId, can } = useStore()
  const canEdit = can(ClientPermissions.SETTINGS_EDIT)
  const save = useSaveReturnSettings(storeId)
  const [payer, setPayer] = useState(saved.returnShippingPayer)
  const changed = payer !== saved.returnShippingPayer
  useUnsavedChanges(canEdit && changed)
  const disabled = !canEdit || save.isPending

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (disabled || !changed) return
    save.mutate(
      { returnShippingPayer: payer },
      {
        onSuccess: view => {
          setSaved(view)
          setPayer(view.returnShippingPayer)
          toast.success(t('saved'))
        },
        onError: error => toast.error(errorText(error))
      }
    )
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5" aria-label={t('formLabel')}>
      {canEdit ? null : <p className="text-muted-foreground text-sm">{t('readOnly')}</p>}
      <fieldset className="flex flex-col gap-3 rounded-lg border p-4">
        <legend className="px-1 text-sm font-medium">{t('payer.legend')}</legend>
        <p className="text-muted-foreground text-xs">{t('payer.hint')}</p>
        {PAYERS.map(option => (
          <label key={option} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="returnShippingPayer"
              value={option}
              checked={payer === option}
              onChange={() => setPayer(option)}
              disabled={disabled}
              className="mt-1"
            />
            <span>
              {t(`payer.options.${option}.label`)}
              <span className="text-muted-foreground block text-xs">
                {t(`payer.options.${option}.hint`)}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      {canEdit ? (
        <div>
          <Button type="submit" disabled={disabled || !changed} busy={save.isPending}>
            {t('save')}
          </Button>
        </div>
      ) : null}
    </form>
  )
}
