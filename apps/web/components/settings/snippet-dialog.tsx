'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useId, useState } from 'react'
import { toast } from 'sonner'

import { SettingsLimits } from '@platform/core/domain'

import {
  emptySnippetDraft,
  type SnippetDraft,
  snippetChanges,
  snippetDraftOf,
  snippetInputOf,
  snippetProblems
} from '../../lib/settings/content-form'
import type { StoreSnippetView } from '../../lib/settings/snippets-requests'
import { useCreateSnippet, useUpdateSnippet } from '../../lib/settings/use-content'
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
import { Textarea } from '../ui/textarea'

// The editor of one saved reply: the shortcut typed after the slash, a title for the list and the
// message. Opened on a snippet it edits it, sending only what changed.
export function SnippetDialog({
  snippet,
  onClose
}: {
  snippet: StoreSnippetView | null
  onClose: () => void
}): ReactElement {
  const t = useTranslations('settings.snippets.dialog')
  const errorText = useErrorText()
  const tCommon = useTranslations('common')
  const { storeId } = useStore()
  const create = useCreateSnippet(storeId)
  const update = useUpdateSnippet(storeId)
  const idPrefix = useId()
  const [draft, setDraft] = useState<SnippetDraft>(() =>
    snippet === null ? emptySnippetDraft() : snippetDraftOf(snippet)
  )
  const [showProblems, setShowProblems] = useState(false)
  const problems = snippetProblems(draft)
  const saving = create.isPending || update.isPending
  const failure = create.error ?? update.error
  const set = (patch: Partial<SnippetDraft>): void =>
    setDraft(current => ({ ...current, ...patch }))

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (saving) return
    if (problems.length > 0) {
      setShowProblems(true)
      return
    }
    const done = (): void => {
      toast.success(t(snippet === null ? 'created' : 'saved', { title: draft.title.trim() }))
      onClose()
    }
    if (snippet === null) {
      create.mutate(snippetInputOf(draft), { onSuccess: done })
      return
    }
    const changes = snippetChanges(snippet, draft)
    if (Object.keys(changes).length === 0) onClose()
    else update.mutate({ snippetId: snippet.id, input: changes }, { onSuccess: done })
  }

  return (
    <Dialog open onOpenChange={open => (open || saving ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(snippet === null ? 'createTitle' : 'editTitle')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <div className="grid grid-cols-1 gap-1.5">
            <Label htmlFor={`${idPrefix}-shortcut`}>{t('shortcut')}</Label>
            <div className="flex items-center gap-1.5">
              <span aria-hidden className="text-muted-foreground text-sm">
                /
              </span>
              <Input
                id={`${idPrefix}-shortcut`}
                value={draft.shortcut}
                maxLength={SettingsLimits.SNIPPET_SHORTCUT_MAX_LENGTH * 2}
                onChange={event => set({ shortcut: event.target.value })}
                disabled={saving}
                autoCapitalize="none"
                spellCheck={false}
                required
              />
            </div>
            <p className="text-muted-foreground text-xs">{t('shortcutHint')}</p>
          </div>
          <div className="grid grid-cols-1 gap-1.5">
            <Label htmlFor={`${idPrefix}-title`}>{t('titleLabel')}</Label>
            <Input
              id={`${idPrefix}-title`}
              value={draft.title}
              maxLength={SettingsLimits.SNIPPET_TITLE_MAX_LENGTH * 2}
              onChange={event => set({ title: event.target.value })}
              disabled={saving}
              required
            />
          </div>
          <div className="grid grid-cols-1 gap-1.5">
            <Label htmlFor={`${idPrefix}-content`}>{t('content')}</Label>
            <Textarea
              id={`${idPrefix}-content`}
              value={draft.content}
              rows={6}
              onChange={event => set({ content: event.target.value })}
              disabled={saving}
              required
            />
            <p className="text-muted-foreground text-xs">
              {t('contentCount', {
                count: draft.content.length,
                max: SettingsLimits.SNIPPET_CONTENT_MAX_LENGTH
              })}
            </p>
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
