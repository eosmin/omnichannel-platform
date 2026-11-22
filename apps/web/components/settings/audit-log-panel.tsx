'use client'

import { Download } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, type SyntheticEvent, useMemo, useState } from 'react'

import { AppPaths, type AuditLogEntryView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { AuditLogLimits } from '@platform/core/domain'

import {
  auditFilterOf,
  type AuditFilterForm,
  EMPTY_AUDIT_FILTER,
  isAuditRangeReversed,
  isExportTooLarge,
  shortId
} from '../../lib/settings/audit-log-filter'
import { useAuditLog, useExportAuditLog } from '../../lib/settings/use-audit-log'
import { useMembers } from '../../lib/settings/use-team'
import { toast } from '../../lib/toast'
import { MutationError } from '../customers/mutation-error'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { SELECT_CLASS } from '../ui/field-classes'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

import { AuditEntryDialog } from './audit-entry-dialog'
import { LoadFailed, PageLoading } from './states'

// Settings → Store → Audit log: who did what in the store, newest first, with the filters of the api (actor, action, days), one
// entry in detail and the CSV of what the filters show. The rows carry ids and counts, never the name of a customer, so the
// screen does not look any up. The names it does show are the team's, when the member may read the team.
export function AuditLogPanel(): ReactElement {
  const t = useTranslations('settings.auditLog')
  const { storeId, can } = useStore()
  const router = useRouter()
  const [draft, setDraft] = useState<AuditFilterForm>(EMPTY_AUDIT_FILTER)
  const [applied, setApplied] = useState<AuditFilterForm>(EMPTY_AUDIT_FILTER)
  const [openId, setOpenId] = useState<string | null>(null)
  const filter = useMemo(() => auditFilterOf(applied), [applied])
  const log = useAuditLog(storeId, filter)
  const exportCsv = useExportAuditLog(storeId)
  const mayReadTeam = can(ClientPermissions.TEAM_VIEW)
  const members = useMembers(storeId, mayReadTeam)
  const reversed = isAuditRangeReversed(draft)
  const rows = log.data?.pages.flatMap(page => page.data) ?? []

  const actorName = (userId: string | null): string => {
    if (userId === null) return t('actor.system')
    const member = members.data?.find(item => item.userId === userId)
    return member === undefined ? t('actor.unknown', { id: shortId(userId) }) : member.name
  }

  const actorSelectShown = mayReadTeam && members.data !== undefined
  // The file is for what the table shows: typed filters not applied yet are not part of it
  const dirty = (Object.keys(draft) as (keyof AuditFilterForm)[]).some(
    key => draft[key] !== applied[key]
  )
  const apply = (event: SyntheticEvent): void => {
    event.preventDefault()
    if (reversed) return
    exportCsv.reset()
    // The same filter again is a new reading asked on purpose (the log is never re-read by itself)
    if (!dirty) {
      void log.refetch()
      return
    }
    // An actor picked and then hidden (the team failed to load) is not sent: the person cannot see it
    setApplied(actorSelectShown ? draft : { ...draft, userId: '' })
  }
  const clear = (): void => {
    exportCsv.reset()
    setDraft(EMPTY_AUDIT_FILTER)
    setApplied(EMPTY_AUDIT_FILTER)
  }
  const exportFile = (): void => {
    // mutateAsync so the toast also appears when the person has already left the page
    exportCsv
      .mutateAsync(filter)
      .then(() =>
        toast.success(t('export.queued'), {
          action: {
            label: t('export.view'),
            onClick: () => router.push(AppPaths.store.exports(storeId))
          }
        })
      )
      .catch(() => undefined) // the error is drawn below
  }

  return (
    <section className="flex max-w-5xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('intro')}</p>
      </header>

      <form
        onSubmit={apply}
        className="flex flex-wrap items-end gap-3"
        aria-label={t('filters.label')}
      >
        <div className="flex min-w-48 flex-col gap-1">
          <Label htmlFor="audit-action">{t('filters.action')}</Label>
          <Input
            id="audit-action"
            value={draft.action}
            maxLength={AuditLogLimits.ACTION_MAX_LENGTH}
            placeholder={t('filters.actionPlaceholder')}
            onChange={event => setDraft({ ...draft, action: event.target.value })}
          />
        </div>
        {actorSelectShown && members.data !== undefined ? (
          <div className="flex min-w-48 flex-col gap-1">
            <Label htmlFor="audit-actor">{t('filters.actor')}</Label>
            <select
              id="audit-actor"
              className={SELECT_CLASS}
              value={draft.userId}
              onChange={event => setDraft({ ...draft, userId: event.target.value })}
            >
              <option value="">{t('filters.anyActor')}</option>
              {members.data.map(member => (
                <option key={member.userId} value={member.userId}>
                  {member.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="flex flex-col gap-1">
          <Label htmlFor="audit-from">{t('filters.from')}</Label>
          <Input
            id="audit-from"
            type="date"
            value={draft.from}
            aria-invalid={reversed}
            aria-describedby={reversed ? 'audit-range-error' : undefined}
            onChange={event => setDraft({ ...draft, from: event.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="audit-to">{t('filters.to')}</Label>
          <Input
            id="audit-to"
            type="date"
            value={draft.to}
            aria-invalid={reversed}
            aria-describedby={reversed ? 'audit-range-error' : undefined}
            onChange={event => setDraft({ ...draft, to: event.target.value })}
          />
        </div>
        <Button type="submit" disabled={reversed}>
          {t('filters.apply')}
        </Button>
        <Button type="button" variant="outline" onClick={clear}>
          {t('filters.clear')}
        </Button>
      </form>
      {reversed ? (
        <p id="audit-range-error" role="alert" className="text-destructive text-sm">
          {t('filters.reversed')}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={exportCsv.isPending || dirty}
          onClick={exportFile}
        >
          <Download />
          {t('export.button')}
        </Button>
        <p className="text-muted-foreground text-xs">
          {dirty ? t('export.applyFirst') : t('export.hint')}
        </p>
      </div>
      {isExportTooLarge(exportCsv.error) ? (
        <p role="alert" className="text-destructive text-sm">
          {t('export.tooLarge')}
        </p>
      ) : (
        <MutationError error={exportCsv.error} />
      )}

      {log.isError ? (
        <LoadFailed error={log.error} onRetry={() => void log.refetch()} />
      ) : log.data === undefined ? (
        <PageLoading />
      ) : rows.length === 0 ? (
        log.isPlaceholderData ? (
          <PageLoading />
        ) : (
          <p className="text-muted-foreground py-8 text-center text-sm">{t('empty')}</p>
        )
      ) : (
        <>
          {/* The rows of the previous filter stay while the new one loads: said, and not offered for more */}
          <div
            aria-busy={log.isPlaceholderData}
            className={log.isPlaceholderData ? 'opacity-50' : ''}
          >
            <AuditTable rows={rows} actorName={actorName} onOpen={setOpenId} />
          </div>
          {log.hasNextPage && !log.isPlaceholderData ? (
            <div className="flex justify-center">
              <Button
                type="button"
                variant="outline"
                disabled={log.isFetchingNextPage}
                onClick={() => void log.fetchNextPage()}
              >
                {t('loadMore')}
              </Button>
            </div>
          ) : null}
        </>
      )}

      {openId === null ? null : (
        <AuditEntryDialog
          key={openId}
          id={openId}
          at={rows.find(row => row.id === openId)?.timestamp}
          actorName={actorName}
          onClose={() => setOpenId(null)}
        />
      )}
    </section>
  )
}

function AuditTable({
  rows,
  actorName,
  onOpen
}: {
  rows: readonly AuditLogEntryView[]
  actorName: (userId: string | null) => string
  onOpen: (id: string) => void
}): ReactElement {
  const t = useTranslations('settings.auditLog')
  const format = useFormatter()
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{t('caption')}</caption>
        <thead>
          <tr className="text-muted-foreground border-b text-xs">
            <th scope="col" className="py-2 pr-3 font-medium">
              {t('columns.when')}
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              {t('columns.actor')}
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              {t('columns.action')}
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              {t('columns.resource')}
            </th>
            <th scope="col" className="py-2 font-medium">
              <span className="sr-only">{t('columns.details')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.id} className="border-b align-top last:border-0">
              <td className="py-2 pr-3 whitespace-nowrap">
                {format.dateTime(new Date(row.timestamp), {
                  dateStyle: 'medium',
                  timeStyle: 'medium'
                })}
              </td>
              <td className="py-2 pr-3 [overflow-wrap:anywhere]">{actorName(row.userId)}</td>
              <td className="py-2 pr-3 font-mono text-xs [overflow-wrap:anywhere]">{row.action}</td>
              <td className="py-2 pr-3 text-xs [overflow-wrap:anywhere]">
                {row.resourceType === null ? (
                  <span className="text-muted-foreground">{t('noResource')}</span>
                ) : row.resourceId === null ? (
                  row.resourceType
                ) : (
                  `${row.resourceType} · ${shortId(row.resourceId)}`
                )}
              </td>
              <td className="py-2 text-right">
                <Button type="button" variant="ghost" size="sm" onClick={() => onOpen(row.id)}>
                  {t('open')}
                  <span className="sr-only"> {row.action}</span>
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
