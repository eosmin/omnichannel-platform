'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useId, useState } from 'react'
import { toast } from 'sonner'

import { ApiError } from '@platform/api-client'
import { SettingsLimits } from '@platform/core/domain'
import { ClientErrorCodes } from '@platform/core/errors'

import {
  emptyTagDraft,
  type TagDraft,
  tagChanges,
  tagDraftOf,
  tagInputOf,
  tagProblems
} from '../../lib/settings/content-form'
import type { StoreTagView } from '../../lib/settings/tags-requests'
import { useCreateTag, useUpdateTag } from '../../lib/settings/use-content'
import { useSubmitGuard } from '../../lib/submit-guard'
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

// The editor of one tag (TDD_09 §13): a name, a colour and an optional description. Opened on a tag it
// edits it, sending only what changed; opened on none it makes one.
export function TagDialog({
  tag,
  onClose
}: {
  tag: StoreTagView | null
  onClose: () => void
}): ReactElement {
  const t = useTranslations('settings.tags.dialog')
  const errorText = useErrorText()
  const tCommon = useTranslations('common')
  const { storeId } = useStore()
  const create = useCreateTag(storeId)
  const update = useUpdateTag(storeId)
  const idPrefix = useId()
  const [draft, setDraft] = useState<TagDraft>(() =>
    tag === null ? emptyTagDraft() : tagDraftOf(tag)
  )
  const [showProblems, setShowProblems] = useState(false)
  const problems = tagProblems(draft)
  const saving = create.isPending || update.isPending
  const failure = create.error ?? update.error
  const set = (patch: Partial<TagDraft>): void => setDraft(current => ({ ...current, ...patch }))

  const guard = useSubmitGuard()
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (saving) return
    if (problems.length > 0) {
      setShowProblems(true)
      return
    }
    const name = draft.name.trim()
    const done = (): void => {
      toast.success(t(tag === null ? 'created' : 'saved', { name }))
      onClose()
    }
    if (tag === null) {
      if (guard.enter())
        create.mutate(tagInputOf(draft), { onSuccess: done, onSettled: guard.leave })
      return
    }
    const changes = tagChanges(tag, draft)
    // Nothing changed: the api refuses an empty patch, and there is nothing to save
    if (Object.keys(changes).length === 0) onClose()
    else if (guard.enter())
      update.mutate({ tagId: tag.id, input: changes }, { onSuccess: done, onSettled: guard.leave })
  }

  return (
    <Dialog open onOpenChange={open => (open || saving ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(tag === null ? 'createTitle' : 'editTitle')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <div className="grid grid-cols-1 gap-1.5">
            <Label htmlFor={`${idPrefix}-name`}>{t('name')}</Label>
            <Input
              id={`${idPrefix}-name`}
              value={draft.name}
              maxLength={SettingsLimits.TAG_NAME_MAX_LENGTH * 2}
              onChange={event => set({ name: event.target.value })}
              disabled={saving}
              required
            />
          </div>
          <div className="grid grid-cols-1 gap-1.5">
            <Label htmlFor={`${idPrefix}-color`}>{t('color')}</Label>
            <input
              id={`${idPrefix}-color`}
              type="color"
              value={draft.color}
              onChange={event => set({ color: event.target.value })}
              disabled={saving}
              className="h-9 w-16 cursor-pointer rounded-md border p-1"
            />
          </div>
          <div className="grid grid-cols-1 gap-1.5">
            <Label htmlFor={`${idPrefix}-description`}>{t('descriptionLabel')}</Label>
            <Input
              id={`${idPrefix}-description`}
              value={draft.description}
              maxLength={SettingsLimits.TAG_DESCRIPTION_MAX_LENGTH * 2}
              onChange={event => set({ description: event.target.value })}
              disabled={saving}
            />
            <p className="text-muted-foreground text-xs">{t('descriptionHint')}</p>
          </div>
          {showProblems && problems.length > 0 ? (
            <ul role="alert" className="text-destructive list-disc pl-5 text-sm">
              {problems.map(problem => (
                <li key={problem}>{t(`problems.${problem}`)}</li>
              ))}
            </ul>
          ) : null}
          {failure === null ? null : (
            <p role="alert" className="text-destructive text-sm">
              {failure instanceof ApiError &&
              failure.code === ClientErrorCodes.RESOURCE_ALREADY_EXISTS
                ? t('problems.nameTaken')
                : errorText(failure)}
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
