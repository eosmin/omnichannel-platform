'use client'

import { TriangleAlert } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useId, useState } from 'react'

import { ClientPermissions } from '@platform/core/auth'
import { RetentionBounds } from '@platform/core/domain'

import {
  RETENTION_FIELDS,
  type RetentionDraft,
  retentionChanged,
  retentionDraftOf,
  retentionInputOf,
  retentionProblems,
  shortenedFields
} from '../../lib/settings/retention-form'
import type { RetentionView } from '../../lib/settings/retention-requests'
import { useUnsavedChanges } from '../../lib/settings/unsaved-changes'
import { useSaveRetention } from '../../lib/settings/use-integrations'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

// Settings → Data retention (TDD_05 §10.4, TDD_09 §13): how long the store keeps its conversations, files, analytics events
// and read notifications. The nightly run deletes what is older, so a shorter window is said before it is saved. `saved` is
// what the form started from and, after a save, what that save returned.
export function RetentionPanel({ saved }: { saved: RetentionView }): ReactElement {
  const t = useTranslations('settings.retention')
  const errorText = useErrorText()
  const { storeId, can } = useStore()
  const save = useSaveRetention(storeId)
  const idPrefix = useId()
  const canManage = can(ClientPermissions.SETTINGS_MANAGE_RETENTION)
  const [draft, setDraft] = useState<RetentionDraft>(() => retentionDraftOf(saved))
  const [showProblems, setShowProblems] = useState(false)
  const guard = useSubmitGuard()
  const problems = retentionProblems(draft)
  const dirty = retentionChanged(saved, draft)
  const shortened = shortenedFields(saved, draft)
  // Shortening a window deletes data for good the night after: the person says they know, for the very windows shortened. A
  // different set of shortened windows asks again.
  const shortenedKey = shortened.join()
  const [acknowledged, setAcknowledged] = useState('')
  const needsAcknowledge = shortened.length > 0 && acknowledged !== shortenedKey
  useUnsavedChanges(dirty)

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (save.isPending || !dirty || needsAcknowledge) return
    if (Object.keys(problems).length > 0) {
      setShowProblems(true)
      return
    }
    if (!guard.enter()) return
    save.mutate(retentionInputOf(draft), {
      onSuccess: next => {
        setDraft(retentionDraftOf(next))
        setShowProblems(false)
        toast.success(t('saved'))
      },
      onSettled: guard.leave
    })
  }

  const reset = (): void => {
    setDraft(retentionDraftOf(saved))
    setShowProblems(false)
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      <p className="text-muted-foreground max-w-2xl text-sm">{t('intro')}</p>
      {RETENTION_FIELDS.map(field => {
        const id = `${idPrefix}-${field}`
        const problem = showProblems ? problems[field] : undefined
        const bounds = RetentionBounds[field]
        return (
          <div key={field} className="grid max-w-md grid-cols-1 gap-1.5">
            <Label htmlFor={id}>{t(`fields.${field}.label`)}</Label>
            <div className="flex items-center gap-2">
              <Input
                id={id}
                type="text"
                inputMode="numeric"
                autoComplete="off"
                className="w-28"
                value={draft[field]}
                disabled={!canManage || save.isPending}
                aria-invalid={problem !== undefined}
                aria-describedby={`${id}-hint`}
                onChange={event =>
                  setDraft(current => ({ ...current, [field]: event.target.value }))
                }
              />
              <span className="text-sm">{t('days')}</span>
            </div>
            <p id={`${id}-hint`} className="text-muted-foreground text-xs">
              {t(`fields.${field}.hint`)} {t('range', { min: bounds.min, max: bounds.max })}
            </p>
            {problem === undefined ? null : (
              <p role="alert" className="text-destructive text-sm">
                {t(`problems.${problem}`, { min: bounds.min, max: bounds.max })}
              </p>
            )}
          </div>
        )
      })}
      {shortened.length > 0 ? (
        <div className="flex max-w-2xl flex-col gap-3 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          <p role="note" className="flex items-start gap-2">
            <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>
              {t('shortenWarning', {
                fields: shortened.map(field => t(`fields.${field}.name`)).join(', ')
              })}
            </span>
          </p>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={acknowledged === shortenedKey}
              disabled={save.isPending}
              onChange={event => setAcknowledged(event.target.checked ? shortenedKey : '')}
            />
            <span>{t('acknowledge')}</span>
          </label>
        </div>
      ) : null}
      {save.error === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {errorText(save.error)}
        </p>
      )}
      {canManage ? (
        <div className="flex gap-2">
          <Button type="submit" disabled={!dirty || save.isPending || needsAcknowledge}>
            {save.isPending ? t('saving') : t('save')}
          </Button>
          <Button type="button" variant="ghost" disabled={!dirty || save.isPending} onClick={reset}>
            {t('discard')}
          </Button>
        </div>
      ) : null}
    </form>
  )
}
