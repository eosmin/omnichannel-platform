'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useId, useState } from 'react'

import { ClientPermissions } from '@platform/core/auth'

import { useStore } from '../../components/providers/store-context'
import { LoadFailed, PageLoading, PermissionDenied } from '../../components/settings/states'
import { Button } from '../../components/ui/button'
import { SELECT_CLASS } from '../../components/ui/field-classes'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import {
  DEFAULT_REOPEN_DAYS,
  type InboxDraft,
  inboxChanges,
  inboxDraftOf,
  inboxProblems
} from '../../lib/settings/content-form'
import type { InboxSettingsView, PreferencesView } from '../../lib/settings/inbox-requests'
import { useUnsavedChanges } from '../../lib/settings/unsaved-changes'
import {
  useInboxSettings,
  usePreferences,
  useSaveInboxSettings,
  useSavePreferences
} from '../../lib/settings/use-content'
import { useSnippetChoices } from '../../lib/settings/use-routing'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'

// Settings → Store → Inbox behavior (TDD_09 §3 and §13): how resolving, reopening and archiving work,
// the load at which the team widget flags an agent, and the read-receipts switch that Step 3.1 reads.
// Opening needs SETTINGS_VIEW (both reads), saving the first group SETTINGS_EDIT and the switch
// SETTINGS_MANAGE_PREFERENCES, as the api asks. The rest of the preferences is Step 4.14; no CSAT.
export function StoreInboxPage(): ReactElement {
  const { can } = useStore()
  return can(ClientPermissions.SETTINGS_VIEW) ? (
    <InboxLoader />
  ) : (
    <PermissionDenied permission={ClientPermissions.SETTINGS_VIEW} />
  )
}

function InboxLoader(): ReactElement {
  const t = useTranslations('settings.inbox')
  const { storeId } = useStore()
  const inbox = useInboxSettings(storeId)
  if (inbox.isError) return <LoadFailed error={inbox.error} onRetry={() => void inbox.refetch()} />
  if (inbox.data === undefined) return <PageLoading />
  return (
    <section className="flex max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
      </header>
      <BehaviorForm saved={inbox.data} />
      <ReceiptsLoader />
    </section>
  )
}

// The switch reads its own route: a failure of one does not hide the other
function ReceiptsLoader(): ReactElement {
  const { storeId } = useStore()
  const preferences = usePreferences(storeId)
  if (preferences.isError) {
    return <LoadFailed error={preferences.error} onRetry={() => void preferences.refetch()} />
  }
  if (preferences.data === undefined) return <PageLoading />
  return (
    <>
      <ReceiptsForm saved={preferences.data} />
      <AssignOnReplyForm saved={preferences.data} />
    </>
  )
}

// `saved` is what the form started from and, after a save of its own, what that save returned. A read
// that brings another person's change later does not move it: only what this person edited is sent,
// so a field they never touched cannot revert the other change.
function BehaviorForm({ saved: loaded }: { saved: InboxSettingsView }): ReactElement {
  const [saved, setSaved] = useState(loaded)
  const t = useTranslations('settings.inbox')
  const errorText = useErrorText()
  const { storeId, can } = useStore()
  const canEdit = can(ClientPermissions.SETTINGS_EDIT)
  const mayListSnippets = can(ClientPermissions.CONVERSATIONS_VIEW)
  const snippets = useSnippetChoices(storeId, mayListSnippets)
  const save = useSaveInboxSettings(storeId)
  const idPrefix = useId()
  const [draft, setDraft] = useState<InboxDraft>(() => inboxDraftOf(saved))
  const [showProblems, setShowProblems] = useState(false)
  const problems = inboxProblems(draft)
  const changes = inboxChanges(saved, draft)
  useUnsavedChanges(canEdit && Object.keys(changes).length > 0)
  const disabled = !canEdit || save.isPending
  const set = (patch: Partial<InboxDraft>): void => setDraft(current => ({ ...current, ...patch }))
  const snippetList = snippets.data ?? []
  // The closing reply may have been deleted since: the api refuses it, and the select shows it as missing
  const closingKnown =
    draft.closingSnippetId === '' ||
    !snippets.isSuccess ||
    snippetList.some(snippet => snippet.id === draft.closingSnippetId)

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (disabled) return
    if (problems.length > 0) {
      setShowProblems(true)
      return
    }
    if (Object.keys(changes).length === 0) return
    save.mutate(changes, {
      onSuccess: view => {
        setSaved(view)
        toast.success(t('saved'))
      },
      onError: error => toast.error(errorText(error))
    })
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-5"
      noValidate
      aria-label={t('behaviorLabel')}
    >
      {canEdit ? null : <p className="text-muted-foreground text-sm">{t('readOnly')}</p>}

      <fieldset className="flex flex-col gap-2 rounded-lg border p-4">
        <legend className="px-1 text-sm font-medium">{t('resolve.legend')}</legend>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name={`${idPrefix}-resolve`}
            checked={!draft.resolveShowOptions}
            onChange={() => set({ resolveShowOptions: false })}
            disabled={disabled}
            className="mt-1"
          />
          <span>
            {t('resolve.immediately')}
            <span className="text-muted-foreground block text-xs">
              {t('resolve.immediatelyHint')}
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name={`${idPrefix}-resolve`}
            checked={draft.resolveShowOptions}
            onChange={() => set({ resolveShowOptions: true })}
            disabled={disabled}
            className="mt-1"
          />
          <span>
            {t('resolve.showOptions')}
            <span className="text-muted-foreground block text-xs">
              {t('resolve.showOptionsHint')}
            </span>
          </span>
        </label>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.sendClosingMessage}
            onChange={event => set({ sendClosingMessage: event.target.checked })}
            disabled={disabled}
          />
          {t('closing.send')}
        </label>
        <div className="grid max-w-sm gap-1.5">
          <Label htmlFor={`${idPrefix}-closing`}>{t('closing.snippet')}</Label>
          <select
            id={`${idPrefix}-closing`}
            className={SELECT_CLASS}
            value={draft.closingSnippetId}
            disabled={disabled || !mayListSnippets}
            onChange={event => set({ closingSnippetId: event.target.value })}
          >
            <option value="">{t('closing.none')}</option>
            {closingKnown ? null : (
              <option value={draft.closingSnippetId}>{t('closing.missing')}</option>
            )}
            {snippetList.map(snippet => (
              <option key={snippet.id} value={snippet.id}>
                /{snippet.shortcut} · {snippet.title}
              </option>
            ))}
          </select>
          <p className="text-muted-foreground text-xs">
            {mayListSnippets ? t('closing.hint') : t('closing.noAccess')}
          </p>
          {snippets.isError ? (
            <p role="alert" className="text-destructive text-sm">
              {errorText(snippets.error)}
            </p>
          ) : null}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2 rounded-lg border p-4">
        <legend className="px-1 text-sm font-medium">{t('reopen.legend')}</legend>
        <p className="text-muted-foreground text-xs">{t('reopen.hint')}</p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.reopenLimited}
            onChange={event => set({ reopenLimited: event.target.checked })}
            disabled={disabled}
          />
          {t('reopen.limited')}
        </label>
        {draft.reopenLimited ? (
          <div className="grid max-w-40 gap-1.5">
            <Label htmlFor={`${idPrefix}-reopen`}>{t('reopen.days')}</Label>
            <Input
              id={`${idPrefix}-reopen`}
              inputMode="numeric"
              value={draft.reopenWindowDays}
              placeholder={String(DEFAULT_REOPEN_DAYS)}
              onChange={event => set({ reopenWindowDays: event.target.value })}
              disabled={disabled}
            />
          </div>
        ) : null}
      </fieldset>

      <div className="grid max-w-40 gap-1.5">
        <Label htmlFor={`${idPrefix}-archive`}>{t('archive.days')}</Label>
        <Input
          id={`${idPrefix}-archive`}
          inputMode="numeric"
          value={draft.autoArchiveAfterDays}
          onChange={event => set({ autoArchiveAfterDays: event.target.value })}
          disabled={disabled}
        />
        <p className="text-muted-foreground w-80 text-xs">{t('archive.hint')}</p>
      </div>

      <div className="grid max-w-40 gap-1.5">
        <Label htmlFor={`${idPrefix}-load`}>{t('load.threshold')}</Label>
        <Input
          id={`${idPrefix}-load`}
          inputMode="numeric"
          value={draft.agentLoadThreshold}
          onChange={event => set({ agentLoadThreshold: event.target.value })}
          disabled={disabled}
        />
        <p className="text-muted-foreground w-80 text-xs">{t('load.hint')}</p>
      </div>

      {showProblems && problems.length > 0 ? (
        <ul role="alert" className="text-destructive list-disc pl-5 text-sm">
          {problems.map(problem => (
            <li key={problem}>{t(`problems.${problem}`)}</li>
          ))}
        </ul>
      ) : null}
      {canEdit ? (
        <div>
          <Button type="submit" disabled={save.isPending} busy={save.isPending}>
            {t('save')}
          </Button>
        </div>
      ) : null}
    </form>
  )
}

// Same rule as the behavior form: the baseline is the value the form started from or its last save
function ReceiptsForm({ saved: loaded }: { saved: PreferencesView }): ReactElement {
  const [saved, setSaved] = useState(loaded)
  const t = useTranslations('settings.inbox.receipts')
  const errorText = useErrorText()
  const { storeId, can } = useStore()
  const canManage = can(ClientPermissions.SETTINGS_MANAGE_PREFERENCES)
  const save = useSavePreferences(storeId)
  const [value, setValue] = useState(saved.sendReadReceipts)
  const disabled = !canManage || save.isPending
  useUnsavedChanges(canManage && value !== saved.sendReadReceipts)

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (disabled || value === saved.sendReadReceipts) return
    save.mutate(
      { sendReadReceipts: value },
      {
        onSuccess: view => {
          setSaved(view)
          toast.success(t('saved'))
        },
        onError: error => toast.error(errorText(error))
      }
    )
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-lg border p-4"
      aria-label={t('label')}
    >
      <h2 className="text-sm font-medium">{t('title')}</h2>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={value}
          onChange={event => setValue(event.target.checked)}
          disabled={disabled}
          className="mt-1"
        />
        <span>
          {t('switch')}
          <span className="text-muted-foreground block text-xs">{t('hint')}</span>
        </span>
      </label>
      {canManage ? (
        <div>
          <Button type="submit" disabled={disabled || value === saved.sendReadReceipts}>
            {t('save')}
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">{t('readOnly')}</p>
      )}
    </form>
  )
}

// The switch "assign me when I reply": a reply to a conversation nobody has takes it for the agent. Same rule
// as the other form: the baseline is the value the form started from or its last save.
function AssignOnReplyForm({ saved: loaded }: { saved: PreferencesView }): ReactElement {
  const [saved, setSaved] = useState(loaded)
  const t = useTranslations('settings.inbox.assignOnReply')
  const errorText = useErrorText()
  const { storeId, can } = useStore()
  const canManage = can(ClientPermissions.SETTINGS_MANAGE_PREFERENCES)
  const save = useSavePreferences(storeId)
  const [value, setValue] = useState(saved.assignOnReply)
  const disabled = !canManage || save.isPending
  useUnsavedChanges(canManage && value !== saved.assignOnReply)

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (disabled || value === saved.assignOnReply) return
    save.mutate(
      { assignOnReply: value },
      {
        onSuccess: view => {
          setSaved(view)
          toast.success(t('saved'))
        },
        onError: error => toast.error(errorText(error))
      }
    )
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-lg border p-4"
      aria-label={t('label')}
    >
      <h2 className="text-sm font-medium">{t('title')}</h2>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={value}
          onChange={event => setValue(event.target.checked)}
          disabled={disabled}
          className="mt-1"
        />
        <span>
          {t('switch')}
          <span className="text-muted-foreground block text-xs">{t('hint')}</span>
        </span>
      </label>
      {canManage ? (
        <div>
          <Button type="submit" disabled={disabled || value === saved.assignOnReply}>
            {t('save')}
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">{t('readOnly')}</p>
      )}
    </form>
  )
}
