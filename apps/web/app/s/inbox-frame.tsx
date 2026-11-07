'use client'

import { useParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { type ReactElement, type ReactNode, useState } from 'react'

import { Shortcuts } from '@platform/core/domain'

import { ConversationList } from '../../components/inbox/conversation-list'
import { InboxFilters } from '../../components/inbox/inbox-filters'
import { InboxSidebar } from '../../components/inbox/inbox-sidebar'
import { ConversationPane, ShortcutHelp } from '../../components/inbox/lazy-dialogs'
import { RealtimeAnnouncer } from '../../components/inbox/realtime-announcer'
import { SelectConversation } from '../../components/inbox/select-conversation'
import { useStore } from '../../components/providers/store-context'
import { ShortcutsProvider, useShortcut } from '../../components/shortcuts/shortcuts-provider'
import { useGoToShortcuts } from '../../components/shortcuts/use-go-to'
import {
  useChannelDirectory,
  useConversationCounts,
  useMemberDirectory,
  useTags
} from '../../lib/inbox/use-inbox-data'
import { useInboxFilters } from '../../lib/inbox/use-inbox-filters'
import { useMountedOnce } from '../../lib/use-mounted-once'
import { cn } from '../../lib/utils'

const NO_CHANNELS: never[] = []
const NO_MEMBERS: never[] = []
const NO_TAGS: never[] = []

// The inbox is the list on the left and the conversation on the right: its header, its thread and its
// composer (the customer panel of Step 3.3 joins as a third column). On a phone it is a stack of screens (TDD_09 §16.4): the list, and the
// conversation when one is open; the address says which, so the back button of the browser works.
// The inbox uses the whole area: the frame of the app (`AppFrame`) is exactly the window and has no padding on this
// route (`isInboxPath`), so the panes below scroll on their own and the page does not.
export function InboxFrame({ children }: { children: ReactNode }): ReactElement {
  return (
    <ShortcutsProvider>
      <InboxLayout>{children}</InboxLayout>
    </ShortcutsProvider>
  )
}

function InboxLayout({ children }: { children: ReactNode }): ReactElement {
  const t = useTranslations('inbox')
  const { storeId } = useStore()
  const { conversationId } = useParams<{ conversationId?: string }>()
  const { filters, search, setFilters } = useInboxFilters()
  const counts = useConversationCounts(storeId)
  const channels = useChannelDirectory(storeId)
  const members = useMemberDirectory(storeId)
  const tags = useTags(storeId)
  const isOpen = conversationId !== undefined
  const [isHelpOpen, setHelpOpen] = useState(false)
  const isHelpMounted = useMountedOnce(isHelpOpen)
  useShortcut(Shortcuts.list.SHOW_HELP, () => setHelpOpen(true))
  useGoToShortcuts(search)

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div
        className={cn(
          // On a phone the filters and the list are one column that scrolls as a whole (the filters alone can be
          // taller than the window); from `md` the list scrolls on its own below the filters
          'flex w-full min-w-0 flex-col border-r max-md:overflow-y-auto md:w-[280px] md:shrink-0',
          isOpen && 'hidden md:flex'
        )}
      >
        <InboxFilters
          filters={filters}
          onChange={setFilters}
          counts={counts.data}
          channels={channels.data ?? NO_CHANNELS}
          members={members.data ?? NO_MEMBERS}
          tags={tags.data ?? NO_TAGS}
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
          <ConversationPane conversationId={conversationId} />
        )}
        {children}
      </section>
      <InboxSidebar />
      <RealtimeAnnouncer />
      {isHelpMounted ? (
        <ShortcutHelp open={isHelpOpen} onOpenChange={setHelpOpen} isConversationOpen={isOpen} />
      ) : null}
    </div>
  )
}
