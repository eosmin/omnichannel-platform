'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useId, useState } from 'react'

import { WebhookLimits } from '@platform/core/domain'

import { useUnsavedChanges } from '../../lib/settings/unsaved-changes'
import { useCreateWebhook, useUpdateWebhook } from '../../lib/settings/use-integrations'
import {
  emptyWebhookDraft,
  eventGroups,
  setGroup,
  toggleEvent,
  type WebhookDraft,
  webhookChanges,
  webhookDraftOf,
  webhookProblems
} from '../../lib/settings/webhook-form'
import type { WebhookView, WebhookWithSecretView } from '../../lib/settings/webhooks-requests'
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

const GROUPS = eventGroups()

// The editor of one webhook: its https address and the events it follows. Opened on a webhook it sends only what changed;
// opened on none it makes one and hands the page its secret, which the api says only once.
export function WebhookDialog({
  webhook,
  onCreated,
  onClose
}: {
  webhook: WebhookView | null
  onCreated: (created: WebhookWithSecretView) => void
  onClose: () => void
}): ReactElement {
  const t = useTranslations('settings.webhooks.dialog')
  const tCommon = useTranslations('common')
  const tEvents = useTranslations('settings.webhooks.events')
  const tGroups = useTranslations('settings.webhooks.groups')
  const errorText = useErrorText()
  const { storeId } = useStore()
  const create = useCreateWebhook(storeId)
  const update = useUpdateWebhook(storeId)
  const idPrefix = useId()
  const [draft, setDraft] = useState<WebhookDraft>(() =>
    webhook === null ? emptyWebhookDraft() : webhookDraftOf(webhook)
  )
  const [showProblems, setShowProblems] = useState(false)
  const problems = webhookProblems(draft)
  const saving = create.isPending || update.isPending
  const failure = create.error ?? update.error
  const guard = useSubmitGuard()
  // Leaving while the webhook is being made would lose its secret: the api makes it and the answer has nowhere to go
  useUnsavedChanges(create.isPending)

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (saving) return
    if (problems.length > 0) {
      setShowProblems(true)
      return
    }
    if (webhook === null) {
      if (!guard.enter()) return
      create.mutate(
        { url: draft.url.trim(), events: draft.events },
        {
          onSuccess: created => {
            toast.success(t('created'))
            onCreated(created)
          },
          onSettled: guard.leave
        }
      )
      return
    }
    const changes = webhookChanges(webhook, draft)
    // Nothing changed: the api refuses an empty patch, and there is nothing to save
    if (Object.keys(changes).length === 0) {
      onClose()
      return
    }
    if (!guard.enter()) return
    update.mutate(
      { webhookId: webhook.id, input: changes },
      {
        onSuccess: () => {
          toast.success(t('saved'))
          onClose()
        },
        onSettled: guard.leave
      }
    )
  }

  return (
    <Dialog open onOpenChange={open => (open || saving ? undefined : onClose())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t(webhook === null ? 'createTitle' : 'editTitle')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <div className="grid grid-cols-1 gap-1.5">
            <Label htmlFor={`${idPrefix}-url`}>{t('url')}</Label>
            <Input
              id={`${idPrefix}-url`}
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder={t('urlPlaceholder')}
              value={draft.url}
              maxLength={WebhookLimits.URL_MAX_LENGTH + 64}
              onChange={event => setDraft(current => ({ ...current, url: event.target.value }))}
              disabled={saving}
              required
            />
            <p className="text-muted-foreground text-xs">{t('urlHint')}</p>
          </div>
          <fieldset className="flex flex-col gap-3" disabled={saving}>
            <legend className="text-sm font-medium">{t('events')}</legend>
            <p className="text-muted-foreground text-xs">{t('eventsHint')}</p>
            {GROUPS.map(group => {
              const chosen = group.events.filter(event => draft.events.includes(event))
              const all = chosen.length === group.events.length
              return (
                <div key={group.group} className="flex flex-col gap-1.5 rounded-md border p-3">
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <input
                      type="checkbox"
                      checked={all}
                      ref={node => {
                        if (node !== null) node.indeterminate = chosen.length > 0 && !all
                      }}
                      onChange={event =>
                        setDraft(current => ({
                          ...current,
                          events: setGroup(current.events, group, event.target.checked)
                        }))
                      }
                    />
                    {tGroups(group.group as 'order')}
                  </label>
                  <ul className="grid grid-cols-1 gap-1 pl-6 sm:grid-cols-2">
                    {group.events.map(event => (
                      <li key={event}>
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={draft.events.includes(event)}
                            onChange={() =>
                              setDraft(current => ({
                                ...current,
                                events: toggleEvent(current.events, event)
                              }))
                            }
                          />
                          <span>{tEvents(event as 'order.created')}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })}
          </fieldset>
          {showProblems && problems.length > 0 ? (
            <ul role="alert" className="text-destructive list-disc pl-5 text-sm">
              {problems.map(problem => (
                <li key={problem}>{t(`problems.${problem}`)}</li>
              ))}
            </ul>
          ) : null}
          {failure === null ? null : (
            <p role="alert" className="text-destructive text-sm">
              {errorText(failure)}
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
