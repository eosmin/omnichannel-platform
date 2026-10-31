'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { Permissions } from '@platform/core/auth'
import { PresenceStatus } from '@platform/core/realtime'

import { buildTeamRows } from '../../lib/inbox/team-status'
import {
  useConversationCounts,
  useInboxBehavior,
  useMemberDirectory
} from '../../lib/inbox/use-inbox-data'
import { useTeamPresence } from '../../lib/realtime/use-team-presence'
import { cn } from '../../lib/utils'
import { useStore } from '../providers/store-context'

const DOT_COLORS: Record<PresenceStatus, string> = {
  [PresenceStatus.ONLINE]: 'bg-emerald-500',
  [PresenceStatus.AWAY]: 'bg-amber-500',
  [PresenceStatus.OFFLINE]: 'bg-muted-foreground/40'
}

// Who of the team is online, away or offline and, for who may see every conversation, how many each
// one still has to work (TDD_09 §8). The word beside the dot says the state: the color is not alone.
export function TeamStatusWidget(): ReactElement {
  const t = useTranslations('inbox.sidebar.team')
  const { storeId, can } = useStore()
  const members = useMemberDirectory(storeId)
  const presence = useTeamPresence(storeId)
  const counts = useConversationCounts(storeId)
  const behavior = useInboxBehavior(storeId)
  const showLoad = can(Permissions.CONVERSATIONS_VIEW_ALL)

  if (members.isError || presence.isError) {
    return (
      <p role="alert" className="text-destructive text-sm">
        {t('failed')}
      </p>
    )
  }
  if (members.data === undefined || presence.data === undefined) {
    return <p className="text-muted-foreground text-sm">{t('loading')}</p>
  }

  const rows = buildTeamRows({
    members: members.data,
    presence: presence.data,
    activeByAgent: counts.data?.activeByAgent ?? [],
    threshold: behavior.data?.agentLoadThreshold ?? null,
    // Until the counts arrive a zero would be a lie
    showLoad: showLoad && counts.data !== undefined
  })
  if (rows.length === 0) return <p className="text-muted-foreground text-sm">{t('empty')}</p>

  return (
    <ul className="flex flex-col gap-2">
      {rows.map(row => (
        <li key={row.userId} className="flex items-center gap-2 text-sm">
          <span
            aria-hidden
            className={cn('size-2 shrink-0 rounded-full', DOT_COLORS[row.status])}
          />
          <span className="min-w-0 flex-1 truncate font-medium">{row.name}</span>
          <span className="text-muted-foreground text-xs">{t(`status.${row.status}`)}</span>
          {row.active === null ? null : (
            <span
              className={cn(
                'text-muted-foreground text-xs tabular-nums',
                row.isOverThreshold && 'font-semibold text-amber-700 dark:text-amber-400'
              )}
            >
              {row.isOverThreshold
                ? t('loadOver', { count: row.active })
                : t('load', { count: row.active })}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}
