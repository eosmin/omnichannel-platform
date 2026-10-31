'use client'

import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { AppPaths } from '@platform/api-client'
import { Permissions } from '@platform/core/auth'
import { BulkActions, ConversationAssignedFilters, ConversationStatus } from '@platform/core/domain'

import { paramsFromFilters } from '../../lib/inbox/inbox-filters'
import { relativeTime } from '../../lib/inbox/relative-time'
import { useBulkRunner } from '../../lib/inbox/use-bulk-actions'
import { useCustomerNamer } from '../../lib/inbox/use-customer-name'
import { useChannelDirectory, useConversationPages } from '../../lib/inbox/use-inbox-data'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

const QUEUE_FILTERS = {
  assigned: ConversationAssignedFilters.UNASSIGNED,
  status: ConversationStatus.OPEN
}
const SHOWN = 5

// The open conversations nobody holds, oldest message waiting first as the list gives them, each with
// "Take it" for who may assign (TDD_09 §8). It shows the first few; "See all" opens the list on them.
export function UnassignedQueueWidget(): ReactElement {
  const t = useTranslations('inbox.sidebar.queue')
  const locale = useLocale()
  const { storeId, can } = useStore()
  const queue = useConversationPages(storeId, QUEUE_FILTERS)
  const channels = useChannelDirectory(storeId)
  const runner = useBulkRunner()
  const nameOf = useCustomerNamer()
  const [now] = useState(() => new Date())
  const mayTake = can(Permissions.CONVERSATIONS_RESOLVE) || can(Permissions.CONVERSATIONS_ASSIGN)

  if (queue.isError) {
    return (
      <p role="alert" className="text-destructive text-sm">
        {t('failed')}
      </p>
    )
  }
  if (queue.data === undefined)
    return <p className="text-muted-foreground text-sm">{t('loading')}</p>

  const first = queue.data.pages[0]
  const items = first?.data.slice(0, SHOWN) ?? []
  if (items.length === 0) return <p className="text-muted-foreground text-sm">{t('empty')}</p>
  const hasMore = (first?.data.length ?? 0) > SHOWN || first?.hasMore === true
  const channelNameOf = (channelType: string): string =>
    channels.data?.find(channel => channel.pluginId === channelType)?.pluginName ?? channelType

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-2">
        {items.map(item => {
          const name = nameOf(item.customer, channelNameOf(item.channelType))
          return (
            <li key={item.id} className="flex items-center gap-2 text-sm">
              <Link
                href={AppPaths.store.conversation(storeId, item.id)}
                className="min-w-0 flex-1 truncate font-medium hover:underline"
              >
                {name}
              </Link>
              {item.lastMessageAt === null ? null : (
                <span className="text-muted-foreground shrink-0 text-xs">
                  {relativeTime(new Date(item.lastMessageAt), now, locale)}
                </span>
              )}
              {mayTake ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={runner.isPending}
                  aria-label={t('takeFor', { name })}
                  onClick={() => {
                    if (!runner.claim()) return
                    void runner.run(
                      { action: BulkActions.ASSIGN_TO_ME },
                      { conversationIds: [item.id] },
                      [item],
                      name
                    )
                  }}
                >
                  {t('take')}
                </Button>
              ) : null}
            </li>
          )
        })}
      </ul>
      {hasMore ? (
        <Link
          href={`${AppPaths.store.inbox(storeId)}?${paramsFromFilters(QUEUE_FILTERS).toString()}`}
          className="text-muted-foreground text-xs underline"
        >
          {t('seeAll')}
        </Link>
      ) : null}
    </div>
  )
}
