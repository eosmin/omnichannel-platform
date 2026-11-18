'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useId, useMemo, useState } from 'react'

import { ApiKeyLimits } from '@platform/core/domain'

import {
  type ApiKeyDraft,
  apiKeyInputOf,
  apiKeyProblems,
  emptyApiKeyDraft,
  grantableScopes,
  scopeGroups,
  todayInput
} from '../../lib/settings/api-key-form'
import type { ApiKeyWithTokenView } from '../../lib/settings/api-keys-requests'
import { useUnsavedChanges } from '../../lib/settings/unsaved-changes'
import { useCreateApiKey } from '../../lib/settings/use-integrations'
import { useSubmitGuard } from '../../lib/submit-guard'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

// The form of a new API key (TDD_09 §13): a name, the permissions it holds and an optional last day. Only the permissions of the
// person that makes it are offered, because a key never holds more than its maker. The key itself comes back once, to the page.
export function ApiKeyDialog({
  onCreated,
  onClose
}: {
  onCreated: (created: ApiKeyWithTokenView) => void
  onClose: () => void
}): ReactElement {
  const t = useTranslations('settings.apiKeys.dialog')
  const tScopes = useTranslations('settings.team.permissions')
  const tResources = useTranslations('settings.apiKeys.resources')
  const tCommon = useTranslations('common')
  const errorText = useErrorText()
  const format = useFormatter()
  const { storeId, permissions } = useStore()
  const create = useCreateApiKey(storeId)
  const idPrefix = useId()
  const groups = useMemo(() => scopeGroups(grantableScopes(permissions)), [permissions])
  const [draft, setDraft] = useState<ApiKeyDraft>(emptyApiKeyDraft)
  const [showProblems, setShowProblems] = useState(false)
  const problems = apiKeyProblems(draft, new Date())
  const saving = create.isPending
  const guard = useSubmitGuard()
  // Leaving while the key is being made would lose it: the api makes it and the answer has nowhere to go
  useUnsavedChanges(saving)
  // The day the date field counts from is the one on this device's clock (`todayInput`), so the hint says that day, in
  // the zone of the device and not in the zone the rest of the page is drawn in (N-BR2-01)
  const today = format.dateTime(new Date(), {
    dateStyle: 'short',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
  })

  const toggle = (scope: string): void =>
    setDraft(current => ({
      ...current,
      scopes: current.scopes.includes(scope)
        ? current.scopes.filter(item => item !== scope)
        : [...current.scopes, scope]
    }))

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (saving) return
    // Checked again now: the dialog may have been open across midnight, and the day it holds may have passed
    if (apiKeyProblems(draft, new Date()).length > 0) {
      setShowProblems(true)
      return
    }
    // Built before the guard is taken: a throw after it would leave the guard busy for good
    const input = apiKeyInputOf(draft)
    if (!guard.enter()) return
    create.mutate(input, {
      onSuccess: created => {
        toast.success(t('created'))
        onCreated(created)
      },
      onSettled: guard.leave
    })
  }

  return (
    <Dialog open onOpenChange={open => (open || saving ? undefined : onClose())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <div className="grid grid-cols-1 gap-1.5">
            <Label htmlFor={`${idPrefix}-name`}>{t('name')}</Label>
            <Input
              id={`${idPrefix}-name`}
              value={draft.name}
              maxLength={ApiKeyLimits.NAME_MAX_LENGTH * 2}
              autoComplete="off"
              aria-describedby={`${idPrefix}-name-hint`}
              onChange={event => setDraft(current => ({ ...current, name: event.target.value }))}
              disabled={saving}
              required
            />
            <p id={`${idPrefix}-name-hint`} className="text-muted-foreground text-xs">
              {t('nameHint')}
            </p>
          </div>
          <div className="grid grid-cols-1 gap-1.5">
            <Label htmlFor={`${idPrefix}-expires`}>{t('expires')}</Label>
            <Input
              id={`${idPrefix}-expires`}
              type="date"
              min={todayInput(new Date())}
              aria-describedby={`${idPrefix}-expires-hint`}
              value={draft.expiresOn}
              onChange={event =>
                setDraft(current => ({ ...current, expiresOn: event.target.value }))
              }
              disabled={saving}
            />
            <p id={`${idPrefix}-expires-hint`} className="text-muted-foreground text-xs">
              {t('expiresHint', { today })}
            </p>
          </div>
          <fieldset
            className="flex flex-col gap-3"
            disabled={saving}
            aria-describedby={`${idPrefix}-scopes-hint`}
          >
            <legend className="text-sm font-medium">{t('scopes')}</legend>
            <p id={`${idPrefix}-scopes-hint`} className="text-muted-foreground text-xs">
              {t('scopesHint')}
            </p>
            {groups.length === 0 ? (
              <p className="text-sm">{t('noScopesHeld')}</p>
            ) : (
              groups.map(group => (
                <div key={group.resource} className="flex flex-col gap-1.5 rounded-md border p-3">
                  <span className="text-sm font-medium">
                    {tResources(group.resource as 'orders')}
                  </span>
                  <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                    {group.scopes.map(scope => (
                      <li key={scope}>
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={draft.scopes.includes(scope)}
                            onChange={() => toggle(scope)}
                          />
                          <span>
                            {tScopes.has(scope.replace(':', '.') as 'settings.view')
                              ? tScopes(scope.replace(':', '.') as 'settings.view')
                              : scope}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )}
          </fieldset>
          {showProblems && problems.length > 0 ? (
            <ul role="alert" className="text-destructive list-disc pl-5 text-sm">
              {problems.map(problem => (
                <li key={problem}>{t(`problems.${problem}`)}</li>
              ))}
            </ul>
          ) : null}
          {create.error === null ? null : (
            <p role="alert" className="text-destructive text-sm">
              {errorText(create.error)}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
              {tCommon('cancel')}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? t('saving') : t('save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
