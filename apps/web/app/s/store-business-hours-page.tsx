'use client'

import { Clock } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useId, useMemo, useState } from 'react'
import { toast } from 'sonner'

import { Permissions } from '@platform/core/auth'
import { Weekdays } from '@platform/core/domain'

import { useStore } from '../../components/providers/store-context'
import { HoursEditor } from '../../components/settings/hours-editor'
import { LoadFailed, PageLoading, PermissionDenied } from '../../components/settings/states'
import { Button } from '../../components/ui/button'
import { SELECT_CLASS } from '../../components/ui/field-classes'
import { Label } from '../../components/ui/label'
import { useInboxBehavior } from '../../lib/inbox/use-inbox-data'
import {
  closedWeek,
  DEFAULT_RANGE,
  WORKING_DAYS,
  weekProblems
} from '../../lib/settings/hours-form'
import type { BusinessHoursView } from '../../lib/settings/hours-requests'
import { intlValues, withCurrent } from '../../lib/settings/store-form'
import { useUnsavedChanges } from '../../lib/settings/unsaved-changes'
import {
  useBusinessHours,
  useSaveBusinessHours,
  useSnippetChoices
} from '../../lib/settings/use-routing'
import { useErrorText } from '../../lib/use-error-text'

// Settings → Store → Business hours (TDD_09 §13): the weekly schedule, its time zone, and the saved
// reply sent to a customer who writes outside it. Opening needs SETTINGS_VIEW and saving
// SETTINGS_EDIT, as the api asks.
export function StoreBusinessHoursPage(): ReactElement {
  const { can } = useStore()
  return can(Permissions.SETTINGS_VIEW) ? <HoursLoader /> : <PermissionDenied />
}

function HoursLoader(): ReactElement {
  const { storeId } = useStore()
  const hours = useBusinessHours(storeId)
  if (hours.isError) return <LoadFailed error={hours.error} onRetry={() => void hours.refetch()} />
  if (hours.data === undefined) return <PageLoading />
  return <HoursBody saved={hours.data} />
}

function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

// A store that never saved a schedule starts from Monday to Friday, which is what most stores want and
// is only saved when the person says so. The hours are the store's, so they start in its time zone,
// not in the one of the browser of whoever opens the page
function startingHours(timezone: string): BusinessHoursView {
  const week = closedWeek()
  for (const day of Weekdays.slice(0, WORKING_DAYS)) week[day] = [{ ...DEFAULT_RANGE }]
  return { timezone, schedule: week, awayMessageSnippetId: null }
}

function HoursBody({ saved }: { saved: BusinessHoursView | null }): ReactElement {
  const t = useTranslations('settings.hours')
  const errorText = useErrorText()
  const { storeId, can } = useStore()
  const canEdit = can(Permissions.SETTINGS_EDIT)
  const mayListSnippets = can(Permissions.CONVERSATIONS_VIEW)
  const snippets = useSnippetChoices(storeId, mayListSnippets)
  // The time zone of the store comes with the inbox behavior (CONVERSATIONS_VIEW, as the snippets);
  // without that permission the page can only offer the one of the browser
  const storeBehavior = useInboxBehavior(storeId, mayListSnippets)
  const storeTimezone = storeBehavior.data?.timezone
  const storeTimezonePending = mayListSnippets && storeBehavior.isPending
  const save = useSaveBusinessHours(storeId)
  const idPrefix = useId()
  // null until the person starts a schedule on a store that has none
  const [draft, setDraft] = useState<BusinessHoursView | null>(saved)
  // What the form started from or its last save returned: the changes not saved are the difference
  const [baseline, setBaseline] = useState<BusinessHoursView | null>(saved)
  useUnsavedChanges(JSON.stringify(draft) !== JSON.stringify(baseline))
  const timezones = useMemo(
    () => withCurrent(intlValues('timeZone'), draft?.timezone ?? browserTimezone()),
    [draft?.timezone]
  )

  if (draft === null) {
    return (
      <section className="flex max-w-3xl flex-col gap-4">
        <PageHeader />
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-10 text-center">
          <Clock aria-hidden className="text-muted-foreground size-8" />
          <h2 className="text-base font-semibold">{t('empty.title')}</h2>
          <p className="text-muted-foreground max-w-sm text-sm">{t('empty.body')}</p>
          {canEdit ? (
            <Button
              type="button"
              size="sm"
              disabled={storeTimezonePending || storeBehavior.isError}
              onClick={() => {
                const starting = startingHours(storeTimezone ?? browserTimezone())
                // Starting is not a change: only what the person edits after it is unsaved
                setBaseline(starting)
                setDraft(starting)
              }}
            >
              {t('empty.start')}
            </Button>
          ) : null}
          {storeBehavior.isError ? (
            <p role="alert" className="text-destructive text-sm">
              {errorText(storeBehavior.error)}
            </p>
          ) : null}
        </div>
      </section>
    )
  }

  const problems = weekProblems(draft.schedule)
  const canSave = canEdit && Object.keys(problems).length === 0 && !save.isPending
  const snippetList = snippets.data ?? []
  // The saved reply may have been deleted since: the api refuses it, and the select shows it as missing
  const awayKnown =
    draft.awayMessageSnippetId === null ||
    !snippets.isSuccess ||
    snippetList.some(snippet => snippet.id === draft.awayMessageSnippetId)

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!canSave) return
    save.mutate(draft, {
      onSuccess: stored => {
        setBaseline(stored)
        setDraft(stored)
        toast.success(t('saved'))
      },
      onError: error => toast.error(errorText(error))
    })
  }

  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <PageHeader />
      {canEdit ? null : <p className="text-muted-foreground text-sm">{t('readOnly')}</p>}
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid max-w-sm gap-1.5">
          <Label htmlFor={`${idPrefix}-timezone`}>{t('timezone')}</Label>
          <select
            id={`${idPrefix}-timezone`}
            className={SELECT_CLASS}
            value={draft.timezone}
            disabled={!canEdit || save.isPending}
            onChange={event => setDraft({ ...draft, timezone: event.target.value })}
          >
            {timezones.map(zone => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </div>
        <HoursEditor
          schedule={draft.schedule}
          problems={problems}
          disabled={!canEdit || save.isPending}
          onChange={schedule => setDraft({ ...draft, schedule })}
        />
        <div className="grid max-w-sm gap-1.5">
          <Label htmlFor={`${idPrefix}-away`}>{t('away.title')}</Label>
          <select
            id={`${idPrefix}-away`}
            className={SELECT_CLASS}
            value={draft.awayMessageSnippetId ?? ''}
            disabled={!canEdit || save.isPending || !mayListSnippets}
            onChange={event =>
              setDraft({ ...draft, awayMessageSnippetId: event.target.value || null })
            }
          >
            <option value="">{t('away.none')}</option>
            {awayKnown ? null : (
              <option value={draft.awayMessageSnippetId ?? ''}>{t('away.missing')}</option>
            )}
            {snippetList.map(snippet => (
              <option key={snippet.id} value={snippet.id}>
                /{snippet.shortcut} · {snippet.title}
              </option>
            ))}
          </select>
          <p className="text-muted-foreground text-xs">
            {mayListSnippets ? t('away.hint') : t('away.noAccess')}
          </p>
          {snippets.isError ? (
            <p role="alert" className="text-destructive text-sm">
              {errorText(snippets.error)}
            </p>
          ) : null}
        </div>
        {canEdit ? (
          <div>
            <Button type="submit" disabled={!canSave}>
              {save.isPending ? t('saving') : t('save')}
            </Button>
          </div>
        ) : null}
      </form>
    </section>
  )
}

function PageHeader(): ReactElement {
  const t = useTranslations('settings.hours')
  return (
    <header className="flex flex-col gap-1">
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <p className="text-muted-foreground text-sm">{t('description')}</p>
    </header>
  )
}
