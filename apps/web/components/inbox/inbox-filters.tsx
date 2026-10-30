'use client'

import { useTranslations } from 'next-intl'
import type { ChangeEvent, ReactElement } from 'react'

import type {
  ChannelDirectoryEntryView,
  ConversationCountsView,
  ConversationFilters,
  MemberDirectoryEntryView
} from '@platform/api-client'
import { ConversationAssignedFilters, ConversationStatus } from '@platform/core/domain'

import { hasFilters } from '../../lib/inbox/inbox-filters'
import { Button } from '../ui/button'
import { SELECT_CLASS } from '../ui/field-classes'

const SCOPES = [
  { value: undefined, key: 'all' },
  { value: ConversationAssignedFilters.ME, key: 'mine' },
  { value: ConversationAssignedFilters.UNASSIGNED, key: 'unassigned' }
] as const

// Channels the filter offers: the accounts of the store grouped by plugin, plus any channel that
// still has conversations (an account that was disconnected keeps its history)
export function channelOptionsOf(
  channels: readonly ChannelDirectoryEntryView[],
  counts: ConversationCountsView | undefined,
  selected?: string
): { id: string; name: string }[] {
  const byId = new Map<string, string>()
  for (const channel of channels) byId.set(channel.pluginId, channel.pluginName)
  // The one in the address is always an option, so that the select never says "all" over a filter
  const known = [
    ...Object.keys(counts?.byChannel ?? {}),
    ...(selected === undefined ? [] : [selected])
  ]
  for (const id of known) if (!byId.has(id)) byId.set(id, id)
  return [...byId].map(([id, name]) => ({ id, name }))
}

const isAgentId = (assigned: string | undefined): assigned is string =>
  assigned !== undefined &&
  assigned !== ConversationAssignedFilters.ME &&
  assigned !== ConversationAssignedFilters.UNASSIGNED

function without(
  filters: ConversationFilters,
  key: keyof ConversationFilters
): ConversationFilters {
  return Object.fromEntries(Object.entries(filters).filter(([name]) => name !== key))
}

export function InboxFilters({
  filters,
  onChange,
  counts,
  channels,
  members
}: {
  filters: ConversationFilters
  onChange: (filters: ConversationFilters) => void
  counts: ConversationCountsView | undefined
  channels: readonly ChannelDirectoryEntryView[]
  members: readonly MemberDirectoryEntryView[]
}): ReactElement {
  const t = useTranslations('inbox')
  const tStatus = useTranslations('conversations.status')

  const withCount = (label: string, count: number | undefined): string =>
    count === undefined ? label : t('withCount', { label, count })
  // Counts are loaded: a missing entry is zero. Not loaded yet: no number.
  const countOf = (count: number | undefined): number | undefined =>
    counts === undefined ? undefined : (count ?? 0)
  const countOfScope = (key: (typeof SCOPES)[number]['key']): number | undefined =>
    counts?.[key === 'all' ? 'all' : key]

  // One select writes one field and leaves the others as they are; '' clears it
  const field =
    <K extends keyof ConversationFilters>(key: K) =>
    (event: ChangeEvent<HTMLSelectElement>): void => {
      const value = event.target.value
      onChange(value === '' ? without(filters, key) : { ...filters, [key]: value })
    }

  // An agent in the address that the directory does not list (yet, or any more) stays selected
  const agentId = isAgentId(filters.assigned) ? filters.assigned : ''
  const unlistedAgent = agentId !== '' && !members.some(member => member.id === agentId)

  return (
    <div className="flex flex-col gap-2 p-3">
      <div role="group" aria-label={t('scopeLabel')} className="flex gap-1">
        {SCOPES.map(scope => {
          const isActive = filters.assigned === scope.value
          return (
            <Button
              key={scope.key}
              type="button"
              size="sm"
              variant={isActive ? 'default' : 'outline'}
              aria-pressed={isActive}
              className="flex-1 px-2"
              onClick={() => {
                onChange(
                  scope.value === undefined
                    ? without(filters, 'assigned')
                    : { ...filters, assigned: scope.value }
                )
              }}
            >
              {withCount(t(`scope.${scope.key}`), countOfScope(scope.key))}
            </Button>
          )
        })}
      </div>
      <select
        aria-label={t('statusFilter')}
        className={SELECT_CLASS}
        value={filters.status ?? ''}
        onChange={field('status')}
      >
        <option value="">{t('allStatuses')}</option>
        {Object.values(ConversationStatus).map(status => (
          <option key={status} value={status}>
            {withCount(tStatus(status), countOf(counts?.byStatus[status]))}
          </option>
        ))}
      </select>
      <select
        aria-label={t('channelFilter')}
        className={SELECT_CLASS}
        value={filters.channelType ?? ''}
        onChange={field('channelType')}
      >
        <option value="">{t('allChannels')}</option>
        {channelOptionsOf(channels, counts, filters.channelType).map(channel => (
          <option key={channel.id} value={channel.id}>
            {withCount(channel.name, countOf(counts?.byChannel[channel.id]))}
          </option>
        ))}
      </select>
      <select
        aria-label={t('agentFilter')}
        className={SELECT_CLASS}
        value={agentId}
        onChange={field('assigned')}
      >
        <option value="">{t('allAgents')}</option>
        {unlistedAgent ? <option value={agentId}>{t('otherAgent')}</option> : null}
        {members.map(member => (
          <option key={member.id} value={member.id}>
            {withCount(
              member.name,
              countOf(counts?.byAgent.find(entry => entry.userId === member.id)?.count)
            )}
          </option>
        ))}
      </select>
      {hasFilters(filters) ? (
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange({})}>
          {t('clearFilters')}
        </Button>
      ) : null}
    </div>
  )
}
