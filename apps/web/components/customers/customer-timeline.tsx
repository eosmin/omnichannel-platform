'use client'

import { MessageSquare, GitMerge, StickyNote, Trash2 } from 'lucide-react'
import Link from 'next/link'
import { useFormatter, useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { AppPaths, type CustomerTimelineEntryView } from '@platform/api-client'
import { Permissions } from '@platform/core/auth'
import { CustomerTimelineTypes } from '@platform/core/domain'

import { groupByDay } from '../../lib/customers/timeline-days'
import { useCustomerEdits, useCustomerTimeline } from '../../lib/customers/use-customer-data'
import { conversationStatusOf } from '../../lib/inbox/conversation-status'
import { useChannelName } from '../../lib/inbox/use-inbox-data'
import { useProfile } from '../../lib/use-profile'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs'

import { MutationError } from './mutation-error'

const ALL = 'all'
// Merges stay in the "All" view: they are an event of the record, not something to filter for
type Filter =
  typeof ALL | typeof CustomerTimelineTypes.CONVERSATION | typeof CustomerTimelineTypes.NOTE
const FILTERS: readonly Filter[] = [
  ALL,
  CustomerTimelineTypes.CONVERSATION,
  CustomerTimelineTypes.NOTE
]

function ConversationEntry({
  entry,
  onNavigate
}: {
  entry: Extract<CustomerTimelineEntryView, { type: 'conversation' }>
  onNavigate: () => void
}): ReactElement {
  const t = useTranslations('customers.timeline')
  const tStatus = useTranslations('conversations.status')
  const { storeId } = useStore()
  const channelName = useChannelName(storeId, entry.channelType)
  // A status this page does not know is shown as the text it came as
  const known = conversationStatusOf(entry.status)
  const status = known === null ? entry.status : tStatus(known)
  return (
    <div className="flex flex-col gap-1">
      <p className="flex items-center gap-2 text-sm font-medium">
        <MessageSquare aria-hidden className="size-4" />
        {t('conversation', { channel: channelName })}
      </p>
      <p className="text-muted-foreground text-xs">{status}</p>
      <Link
        href={AppPaths.store.conversation(storeId, entry.id)}
        onClick={onNavigate}
        className="text-sm underline-offset-4 hover:underline"
      >
        {t('openConversation')}
      </Link>
    </div>
  )
}

// A note is deleted by who wrote it or by who may delete customers (the api checks the same)
function NoteEntry({
  entry,
  customerId
}: {
  entry: Extract<CustomerTimelineEntryView, { type: 'note' }>
  customerId: string
}): ReactElement {
  const t = useTranslations('customers.timeline')
  const { storeId, can } = useStore()
  const profile = useProfile()
  const { removeNote } = useCustomerEdits(storeId, customerId)
  const mayDelete =
    can(Permissions.CUSTOMERS_EDIT) &&
    (can(Permissions.CUSTOMERS_DELETE) || profile.data?.id === entry.authorId)
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <p className="flex flex-1 items-center gap-2 text-sm font-medium">
          <StickyNote aria-hidden className="size-4" />
          {entry.authorName === null ? t('note') : t('noteBy', { name: entry.authorName })}
        </p>
        {mayDelete ? (
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label={t('deleteNote')}
            disabled={removeNote.isPending}
            onClick={() => removeNote.mutate(entry.id)}
          >
            <Trash2 />
          </Button>
        ) : null}
      </div>
      <p className="text-sm break-words whitespace-pre-wrap">{entry.content}</p>
      <MutationError error={removeNote.error} />
    </div>
  )
}

function Entry({
  entry,
  customerId,
  onNavigate
}: {
  entry: CustomerTimelineEntryView
  customerId: string
  onNavigate: () => void
}): ReactElement {
  const t = useTranslations('customers.timeline')
  switch (entry.type) {
    case 'conversation':
      return <ConversationEntry entry={entry} onNavigate={onNavigate} />
    case 'note':
      return <NoteEntry entry={entry} customerId={customerId} />
    case 'merge':
      return (
        <div className="flex flex-col gap-1">
          <p className="flex items-center gap-2 text-sm font-medium">
            <GitMerge aria-hidden className="size-4" />
            {entry.unmergedAt === null ? t('merged') : t('unmerged')}
          </p>
          {entry.mergedByName === null ? null : (
            <p className="text-muted-foreground text-xs">
              {t('mergedBy', { name: entry.mergedByName })}
            </p>
          )}
        </div>
      )
  }
}

// The activity of a customer, the newest first, grouped by day (TDD_09 §6). Orders join the filters
// with Step 4.3.
export function CustomerTimeline({
  customerId,
  onNavigate
}: {
  customerId: string
  onNavigate: () => void
}): ReactElement {
  const t = useTranslations('customers.timeline')
  const tAll = useTranslations()
  const format = useFormatter()
  const { storeId, can } = useStore()
  const [filter, setFilter] = useState<Filter>(ALL)
  const timeline = useCustomerTimeline(storeId, customerId, filter === ALL ? undefined : filter)
  const entries = timeline.data?.pages.flatMap(page => page.data) ?? []
  const days = groupByDay(entries)

  return (
    <div className="flex flex-col gap-4">
      <Tabs value={filter} onValueChange={value => setFilter(value as Filter)}>
        <TabsList aria-label={t('filterLabel')}>
          {FILTERS.filter(
            item =>
              item !== CustomerTimelineTypes.CONVERSATION || can(Permissions.CONVERSATIONS_VIEW)
          ).map(item => (
            <TabsTrigger key={item} value={item}>
              {t(`filters.${item}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {timeline.isPending ? (
        <p role="status" className="text-muted-foreground text-sm">
          {tAll('common.loading')}
        </p>
      ) : null}
      {timeline.isError && entries.length === 0 ? (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm">
          <p>{t('failed')}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void timeline.refetch()}>
            {tAll('common.tryAgain')}
          </Button>
        </div>
      ) : null}
      {timeline.isSuccess && entries.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : null}

      {days.map(day => (
        <section key={day.day} aria-labelledby={`day-${day.day}`} className="flex flex-col gap-3">
          <h3
            id={`day-${day.day}`}
            className="text-muted-foreground border-b pb-1 text-xs font-semibold"
          >
            {format.dateTime(day.date, { dateStyle: 'medium' })}
          </h3>
          <ul className="flex flex-col gap-4">
            {day.entries.map(entry => (
              <li key={`${entry.type}-${entry.id}`}>
                <Entry entry={entry} customerId={customerId} onNavigate={onNavigate} />
              </li>
            ))}
          </ul>
        </section>
      ))}

      {timeline.hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          disabled={timeline.isFetchingNextPage}
          onClick={() => void timeline.fetchNextPage()}
        >
          {t('loadMore')}
        </Button>
      ) : null}
    </div>
  )
}
