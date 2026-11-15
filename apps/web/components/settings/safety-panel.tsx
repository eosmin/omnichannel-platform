'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useId, useState } from 'react'

import { ClientPermissions } from '@platform/core/auth'
import { ModerateRiskModes, SafetyRoleNames } from '@platform/core/domain'

import {
  SAFETY_SWITCHES,
  safetyChanged,
  type SafetyDraft,
  safetyDraftOf,
  safetyInputOf,
  toggleRole
} from '../../lib/settings/safety-form'
import type { SafetyView } from '../../lib/settings/safety-requests'
import { useUnsavedChanges } from '../../lib/settings/unsaved-changes'
import { useSaveSafety } from '../../lib/settings/use-safety'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

const MODES = [ModerateRiskModes.DIALOG, ModerateRiskModes.UNDO, ModerateRiskModes.NONE] as const

// Settings → Safety and confirmations (TDD_09 §11.2): what the store asks before a destructive action. The critical tier is
// not here (it always asks for a typed phrase). `saved` is what the form started from and, after a save, what that save returned.
export function SafetyPanel({ saved }: { saved: SafetyView }): ReactElement {
  const t = useTranslations('settings.safety')
  const errorText = useErrorText()
  const { storeId, can } = useStore()
  const save = useSaveSafety(storeId)
  const idPrefix = useId()
  const canEdit = can(ClientPermissions.SETTINGS_EDIT)
  const [draft, setDraft] = useState<SafetyDraft>(() => safetyDraftOf(saved))
  const guard = useSubmitGuard()
  const dirty = safetyChanged(saved, draft)
  const locked = !canEdit || save.isPending
  useUnsavedChanges(dirty)

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (save.isPending || !dirty || !canEdit) return
    if (!guard.enter()) return
    save.mutate(safetyInputOf(saved, draft), {
      onSuccess: next => {
        setDraft(safetyDraftOf(next))
        toast.success(t('saved'))
      },
      onSettled: guard.leave
    })
  }

  return (
    <form onSubmit={submit} noValidate className="flex max-w-2xl flex-col gap-6">
      <p className="text-muted-foreground text-sm">{t('intro')}</p>

      <fieldset className="flex flex-col gap-3">
        <legend className="text-base font-semibold">{t('high.title')}</legend>
        <p className="text-muted-foreground text-sm">{t('high.hint')}</p>
        {SAFETY_SWITCHES.map(key => (
          <label key={key} className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={draft[key]}
              disabled={locked}
              onChange={event => setDraft(current => ({ ...current, [key]: event.target.checked }))}
            />
            <span>{t(`high.switches.${key}`)}</span>
          </label>
        ))}
        <div role="group" aria-labelledby={`${idPrefix}-roles`} className="flex flex-col gap-2">
          <p id={`${idPrefix}-roles`} className="text-sm font-medium">
            {t('high.rolesTitle')}
          </p>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {SafetyRoleNames.map(role => (
              <label key={role} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.applyToRoles.includes(role)}
                  disabled={locked}
                  onChange={() => setDraft(current => toggleRole(current, role))}
                />
                <span>{t(`roles.${role}`)}</span>
              </label>
            ))}
          </div>
          <p className="text-muted-foreground text-xs">{t('high.rolesHint')}</p>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="text-base font-semibold">{t('moderate.title')}</legend>
        <p className="text-muted-foreground text-sm">{t('moderate.hint')}</p>
        {MODES.map(mode => (
          <label key={mode} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name={`${idPrefix}-mode`}
              className="mt-0.5"
              checked={draft.moderateRiskMode === mode}
              disabled={locked}
              onChange={() => setDraft(current => ({ ...current, moderateRiskMode: mode }))}
            />
            <span className="flex flex-col">
              <span>{t(`moderate.modes.${mode}.label`)}</span>
              <span className="text-muted-foreground text-xs">
                {t(`moderate.modes.${mode}.hint`)}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      <p className="text-muted-foreground text-sm">{t('critical')}</p>

      {save.error === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {errorText(save.error)}
        </p>
      )}
      {canEdit ? (
        <div className="flex gap-2">
          <Button type="submit" disabled={!dirty || save.isPending}>
            {save.isPending ? t('saving') : t('save')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={!dirty || save.isPending}
            onClick={() => setDraft(safetyDraftOf(saved))}
          >
            {t('discard')}
          </Button>
        </div>
      ) : null}
    </form>
  )
}
