'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useId, useState } from 'react'

import { ClientPermissions } from '@platform/core/auth'
import { FailedAttemptMessagePolicy, OrderFreeShippingRules } from '@platform/core/domain'
import { RemittancePreferenceLimits } from '@platform/core/store-preferences'

import { useStore } from '../../components/providers/store-context'
import { CancellationReasonsEditor } from '../../components/settings/cancellation-reasons-editor'
import { LoadFailed, PageLoading, PermissionDenied } from '../../components/settings/states'
import { Button } from '../../components/ui/button'
import { SELECT_CLASS } from '../../components/ui/field-classes'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import {
  type PreferencesDraft,
  preferencesChanges,
  preferencesDraftOf,
  preferencesProblems
} from '../../lib/settings/preferences-form'
import type { PreferencesView } from '../../lib/settings/preferences-requests'
import { useUnsavedChanges } from '../../lib/settings/unsaved-changes'
import { usePreferences, useSavePreferences } from '../../lib/settings/use-content'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'

// Settings → Preferences (TDD_17 §4.13, §4.14): what the store decides about its orders and remittances without a
// deploy. The inbox switches (read receipts, assign on reply) are on the Inbox behavior page. Opening needs SETTINGS_VIEW
// and saving SETTINGS_MANAGE_PREFERENCES, as the api asks.
export function StorePreferencesPage(): ReactElement {
  const { can } = useStore()
  return can(ClientPermissions.SETTINGS_VIEW) ? (
    <PreferencesLoader />
  ) : (
    <PermissionDenied permission={ClientPermissions.SETTINGS_VIEW} />
  )
}

function PreferencesLoader(): ReactElement {
  const t = useTranslations('settings.preferences')
  const { storeId } = useStore()
  const preferences = usePreferences(storeId)
  if (preferences.isError) {
    return <LoadFailed error={preferences.error} onRetry={() => void preferences.refetch()} />
  }
  if (preferences.data === undefined) return <PageLoading />
  return (
    <section className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
      </header>
      <PreferencesForm key={storeId} saved={preferences.data} />
    </section>
  )
}

const FREE_SHIPPING_RULES = Object.values(OrderFreeShippingRules)
const FAILED_ATTEMPT_POLICIES = Object.values(FailedAttemptMessagePolicy)

// `saved` is what the form started from and, after a save of its own, what that save returned. A read that brings another
// person's change later does not move it: only what this person edited is sent.
function PreferencesForm({ saved: loaded }: { saved: PreferencesView }): ReactElement {
  const [saved, setSaved] = useState(loaded)
  const t = useTranslations('settings.preferences')
  const errorText = useErrorText()
  const { storeId, can } = useStore()
  const canManage = can(ClientPermissions.SETTINGS_MANAGE_PREFERENCES)
  const save = useSavePreferences(storeId)
  const idPrefix = useId()
  const [draft, setDraft] = useState<PreferencesDraft>(() => preferencesDraftOf(saved))
  const [showProblems, setShowProblems] = useState(false)
  const problems = preferencesProblems(draft)
  const changes = preferencesChanges(saved, draft)
  useUnsavedChanges(canManage && changes !== null)
  const disabled = !canManage || save.isPending
  const set = (patch: Partial<PreferencesDraft>): void =>
    setDraft(current => ({ ...current, ...patch }))

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (disabled) return
    if (problems.length > 0) {
      setShowProblems(true)
      return
    }
    if (changes === null) return
    save.mutate(changes, {
      onSuccess: view => {
        setSaved(view)
        setDraft(preferencesDraftOf(view))
        setShowProblems(false)
        toast.success(t('saved'))
      },
      onError: error => toast.error(errorText(error))
    })
  }

  const has = (problem: string): boolean => showProblems && problems.some(item => item === problem)
  const saveDisabled = disabled || (changes === null && problems.length === 0)
  return (
    <form onSubmit={submit} className="flex flex-col gap-5" noValidate aria-label={t('formLabel')}>
      {canManage ? null : <p className="text-muted-foreground text-sm">{t('readOnly')}</p>}

      <fieldset className="flex flex-col gap-3 rounded-lg border p-4">
        <legend className="px-1 text-sm font-medium">{t('create.legend')}</legend>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.confirmOnCreate}
            onChange={event => set({ confirmOnCreate: event.target.checked })}
            disabled={disabled}
            className="mt-1"
          />
          <span>
            {t('create.confirm')}
            <span className="text-muted-foreground block text-xs">{t('create.confirmHint')}</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.sendSummaryOnCreate}
            onChange={event => set({ sendSummaryOnCreate: event.target.checked })}
            disabled={disabled}
            className="mt-1"
          />
          <span>
            {t('create.summary')}
            <span className="text-muted-foreground block text-xs">{t('create.summaryHint')}</span>
          </span>
        </label>
      </fieldset>

      <fieldset className="flex flex-col gap-3 rounded-lg border p-4">
        <legend className="px-1 text-sm font-medium">{t('shipping.legend')}</legend>
        <div className="grid max-w-md gap-1.5">
          <Label htmlFor={`${idPrefix}-free-shipping`}>{t('shipping.freeShippingLabel')}</Label>
          <select
            id={`${idPrefix}-free-shipping`}
            value={draft.freeShippingRule}
            onChange={event =>
              set({ freeShippingRule: event.target.value as PreferencesDraft['freeShippingRule'] })
            }
            disabled={disabled}
            className={SELECT_CLASS}
          >
            {FREE_SHIPPING_RULES.map(rule => (
              <option key={rule} value={rule}>
                {t(`shipping.freeShippingRules.${rule}`)}
              </option>
            ))}
          </select>
          <p className="text-muted-foreground text-xs">{t('shipping.freeShippingHint')}</p>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-3 rounded-lg border p-4">
        <legend className="px-1 text-sm font-medium">{t('delivery.legend')}</legend>
        <div className="grid max-w-md gap-1.5">
          <Label htmlFor={`${idPrefix}-failed`}>{t('delivery.failedLabel')}</Label>
          <select
            id={`${idPrefix}-failed`}
            value={draft.failedAttemptMessages}
            onChange={event =>
              set({
                failedAttemptMessages: event.target
                  .value as PreferencesDraft['failedAttemptMessages']
              })
            }
            disabled={disabled}
            className={SELECT_CLASS}
          >
            {FAILED_ATTEMPT_POLICIES.map(policy => (
              <option key={policy} value={policy}>
                {t(`delivery.failedPolicies.${policy}`)}
              </option>
            ))}
          </select>
          <p className="text-muted-foreground text-xs">{t('delivery.failedHint')}</p>
        </div>
        <div className="grid max-w-md gap-1.5">
          <Label htmlFor={`${idPrefix}-overdue`}>{t('delivery.overdueLabel')}</Label>
          <Input
            id={`${idPrefix}-overdue`}
            inputMode="numeric"
            value={draft.overdueAfterDays}
            onChange={event => set({ overdueAfterDays: event.target.value })}
            disabled={disabled}
            className="max-w-24"
            aria-invalid={has('overdueDays')}
            aria-describedby={has('overdueDays') ? `${idPrefix}-problems` : undefined}
          />
          <p className="text-muted-foreground text-xs">
            {t('delivery.overdueHint', {
              min: RemittancePreferenceLimits.MIN_OVERDUE_DAYS,
              max: RemittancePreferenceLimits.MAX_OVERDUE_DAYS
            })}
          </p>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-3 rounded-lg border p-4">
        <legend className="px-1 text-sm font-medium">{t('reasons.legend')}</legend>
        <p className="text-muted-foreground text-xs">{t('reasons.hint')}</p>
        <CancellationReasonsEditor
          reasons={draft.cancellationReasons}
          onChange={cancellationReasons => set({ cancellationReasons })}
          disabled={disabled}
        />
      </fieldset>

      {showProblems && problems.length > 0 ? (
        <ul
          id={`${idPrefix}-problems`}
          role="alert"
          className="text-destructive list-disc pl-5 text-sm"
        >
          {problems.map(problem => (
            <li key={problem}>{t(`problems.${problem}`)}</li>
          ))}
        </ul>
      ) : null}
      {canManage ? (
        <div>
          <Button type="submit" disabled={saveDisabled} busy={save.isPending}>
            {t('save')}
          </Button>
        </div>
      ) : null}
    </form>
  )
}
