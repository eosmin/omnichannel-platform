'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useState } from 'react'

import type { FinanceAccountView, FinanceSettingsView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { SaleRecognition, TaxRounding } from '@platform/core/domain'

import { postableAccountsOf } from '../../lib/finance/account-form'
import {
  type SettingsDraft,
  settingsChangesOf,
  settingsDraftOf
} from '../../lib/finance/settings-form'
import { useUpdateFinanceSettings } from '../../lib/finance/use-finance'
import { useUnsavedChanges } from '../../lib/settings/unsaved-changes'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

import { SelectField } from './fields'

// How the books post a sale and its tax (TDD_18 §6.4, §7). Changing any of it needs finance:manage_accounts; without it the form shows.
export function PostingSettingsPanel({
  settings,
  accounts
}: {
  settings: FinanceSettingsView
  accounts: readonly FinanceAccountView[]
}): ReactElement {
  const t = useTranslations('finance.settings.posting')
  const errorText = useErrorText()
  const { storeId, can } = useStore()
  const canManage = can(ClientPermissions.FINANCE_MANAGE_ACCOUNTS)
  const guard = useSubmitGuard()
  const update = useUpdateFinanceSettings(storeId)
  // Only what the person changed is kept: everything else is what the books hold now, so a change made under the form (another person
  // saved, a role was mapped) shows at once and a save never puts back a value the person did not touch
  const [edits, setEdits] = useState<Partial<SettingsDraft>>({})
  const draft: SettingsDraft = { ...settingsDraftOf(settings), ...edits }
  const [refusal, setRefusal] = useState<string | null>(null)
  const changes = settingsChangesOf(settings, draft)
  const changed = Object.keys(changes).length > 0
  useUnsavedChanges(changed)
  const rounding = postableAccountsOf(accounts, [settings.roundingAccountId ?? ''])

  const set = (patch: Partial<SettingsDraft>): void => {
    setEdits(current => ({ ...current, ...patch }))
    setRefusal(null)
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!canManage || !changed || !guard.enter()) return
    update.mutate(changes, {
      onSuccess: () => {
        toast.success(t('saved'))
        setEdits({})
      },
      onError: error => setRefusal(errorText(error)),
      onSettled: guard.leave
    })
  }

  return (
    <section className="flex flex-col gap-3" aria-labelledby="finance-posting-settings-title">
      <h2 id="finance-posting-settings-title" className="text-lg font-semibold">
        {t('title')}
      </h2>
      <p className="text-muted-foreground text-sm">{t('description')}</p>
      <form
        onSubmit={submit}
        noValidate
        className="flex flex-col gap-3"
        aria-label={t('formLabel')}
      >
        <SelectField
          label={t('recognizeSaleOn')}
          value={draft.recognizeSaleOn}
          hint={t('recognizeSaleOnHint')}
          disabled={!canManage || update.isPending}
          onChange={recognizeSaleOn => set({ recognizeSaleOn })}
        >
          {Object.values(SaleRecognition).map(value => (
            <option key={value} value={value}>
              {t(`recognize.${value}`)}
            </option>
          ))}
        </SelectField>
        <SelectField
          label={t('taxRounding')}
          value={draft.taxRounding}
          hint={t('taxRoundingHint')}
          disabled={!canManage || update.isPending}
          onChange={taxRounding => set({ taxRounding })}
        >
          {Object.values(TaxRounding).map(value => (
            <option key={value} value={value}>
              {t(`rounding.${value}`)}
            </option>
          ))}
        </SelectField>
        <SelectField
          label={t('roundingAccount')}
          value={draft.roundingAccountId}
          hint={t('roundingAccountHint')}
          disabled={!canManage || update.isPending}
          onChange={roundingAccountId => set({ roundingAccountId })}
        >
          {settings.roundingAccountId === null ? <option value="">{t('noneYet')}</option> : null}
          {rounding.map(account => (
            <option key={account.id} value={account.id}>
              {account.code} · {account.name}
            </option>
          ))}
        </SelectField>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={draft.shippingTaxed}
            disabled={!canManage || update.isPending}
            onChange={event => set({ shippingTaxed: event.target.checked })}
          />
          <span>
            {t('shippingTaxed')}
            <span className="text-muted-foreground block text-xs">{t('shippingTaxedHint')}</span>
          </span>
        </label>
        {refusal === null ? null : (
          <p role="alert" className="text-destructive text-sm">
            {refusal}
          </p>
        )}
        {canManage ? (
          <div className="flex justify-end">
            <Button type="submit" disabled={update.isPending || !changed}>
              {t('save')}
            </Button>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">{t('readOnly')}</p>
        )}
      </form>
    </section>
  )
}
