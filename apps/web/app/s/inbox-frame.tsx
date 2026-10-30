'use client'

import { useParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { ReactElement, ReactNode } from 'react'

import { ConversationHeader } from '../../components/inbox/conversation-header'
import { ConversationList } from '../../components/inbox/conversation-list'
import { InboxFilters } from '../../components/inbox/inbox-filters'
import { RealtimeAnnouncer } from '../../components/inbox/realtime-announcer'
import { SelectConversation } from '../../components/inbox/select-conversation'
import { useStore } from '../../components/providers/store-context'
import {
  useChannelDirectory,
  useConversationCounts,
  useMemberDirectory
} from '../../lib/inbox/use-inbox-data'
import { useInboxFilters } from '../../lib/inbox/use-inbox-filters'
import { cn } from '../../lib/utils'

const NO_CHANNELS: never[] = []
const NO_MEMBERS: never[] = []

// The inbox is the list on the left and the conversation on the right (the customer panel of Step 3.3
// joins as a third column). On a phone it is a stack of screens (TDD_09 §16.4): the list, and the
// conversation when one is open; the address says which, so the back button of the browser works.
// The page frame pads its content, hence the negative margin: the inbox uses the whole area.
export function InboxFrame({ children }: { children: ReactNode }): ReactElement {
  const t = useTranslations('inbox')
  const { storeId } = useStore()
  const { conversationId } = useParams<{ conversationId?: string }>()
  const { filters, search, setFilters } = useInboxFilters()
  const counts = useConversationCounts(storeId)
  const channels = useChannelDirectory(storeId)
  const members = useMemberDirectory(storeId)
  const isOpen = conversationId !== undefined

  return (
    <div className="-m-4 flex h-[calc(100dvh-3.5rem)]">
      <div
        className={cn(
          'flex w-full min-w-0 flex-col border-r md:w-[280px] md:shrink-0',
          isOpen && 'hidden md:flex'
        )}
      >
        <InboxFilters
          filters={filters}
          onChange={setFilters}
          counts={counts.data}
          channels={channels.data ?? NO_CHANNELS}
          members={members.data ?? NO_MEMBERS}
        />
        <ConversationList
          storeId={storeId}
          filters={filters}
          search={search}
          channels={channels.data ?? NO_CHANNELS}
          areChannelsReady={!channels.isPending}
        />
      </div>
      {/* On a phone with the list showing the section is hidden: the page still needs its heading */}
      {isOpen ? null : <h1 className="sr-only md:hidden">{t('listLabel')}</h1>}
      <section className={cn('min-w-0 flex-1 flex-col', isOpen ? 'flex' : 'hidden md:flex')}>
        {conversationId === undefined ? (
          <SelectConversation />
        ) : (
          <ConversationHeader conversationId={conversationId} />
        )}
        {children}
      </section>
      <RealtimeAnnouncer />
    </div>
  )
}
