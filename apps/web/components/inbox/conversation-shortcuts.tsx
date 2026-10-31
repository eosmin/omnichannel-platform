'use client'

import { useRouter } from 'next/navigation'
import { type ReactElement, useState } from 'react'

import { type BulkOperation, AppPaths } from '@platform/api-client'
import { Permissions } from '@platform/core/auth'
import { BulkActions, ConversationStatus, Shortcuts } from '@platform/core/domain'

import { canChangeState } from '../../lib/inbox/conversation-status'
import { useBulkRunner } from '../../lib/inbox/use-bulk-actions'
import { useCustomerNamer } from '../../lib/inbox/use-customer-name'
import { useChannelName, useConversation } from '../../lib/inbox/use-inbox-data'
import { useInboxFilters } from '../../lib/inbox/use-inbox-filters'
import { ShortcutPriority } from '../../lib/shortcuts/priorities'
import { useCustomerDrawer } from '../customers/customer-drawer-context'
import { useStore } from '../providers/store-context'
import { useShortcut } from '../shortcuts/shortcuts-provider'

import { BulkPickDialog, type BulkPick, BulkPicks } from './bulk-pick-dialog'
import { useConversationControls } from './conversation-controls'

// The keys of the open conversation (TDD_09 §9). Each works only where its button would be offered: with
// its permission and in a state that allows it. The reply box and the note keys are the composer's.
// Changes go through the same runner as the bulk bar, so the toast and the Undo are the same.
export function ConversationShortcuts({
  conversationId
}: {
  conversationId: string
}): ReactElement {
  const router = useRouter()
  const { storeId, can } = useStore()
  const { search } = useInboxFilters()
  const conversation = useConversation(storeId, conversationId)
  const runner = useBulkRunner()
  const nameOf = useCustomerNamer()
  const { openCustomer } = useCustomerDrawer()
  const { resolve, openSnooze } = useConversationControls()
  const [pick, setPick] = useState<BulkPick | null>(null)

  const detail = conversation.data
  const channelName = useChannelName(storeId, detail?.channelType ?? '')
  const isLoaded = detail !== undefined
  const mayChange = isLoaded && canChangeState(detail.status)
  const mayAssign = can(Permissions.CONVERSATIONS_RESOLVE) || can(Permissions.CONVERSATIONS_ASSIGN)
  const mayResolve = can(Permissions.CONVERSATIONS_RESOLVE)

  const run = (operation: BulkOperation): void => {
    if (detail === undefined || !runner.claim()) return
    void runner.run(
      operation,
      { conversationIds: [conversationId] },
      [detail],
      nameOf(detail.customer, channelName)
    )
  }
  const keyboard = { priority: ShortcutPriority.OPEN_CONVERSATION }

  useShortcut(
    Shortcuts.conversation.CLOSE,
    () => router.push(`${AppPaths.store.inbox(storeId)}${search}`),
    keyboard
  )
  useShortcut(
    Shortcuts.conversation.ASSIGN_TO_ME,
    () => run({ action: BulkActions.ASSIGN_TO_ME }),
    {
      ...keyboard,
      enabled: isLoaded && mayAssign
    }
  )
  useShortcut(Shortcuts.conversation.ASSIGN_TO_OTHER, () => setPick(BulkPicks.AGENT), {
    ...keyboard,
    enabled: isLoaded && can(Permissions.CONVERSATIONS_ASSIGN)
  })
  useShortcut(Shortcuts.conversation.ADD_TAG, () => setPick(BulkPicks.ADD_TAG), {
    ...keyboard,
    enabled: isLoaded && mayResolve
  })
  useShortcut(
    Shortcuts.conversation.MARK_PENDING,
    () =>
      run({
        action: BulkActions.SET_STATUS,
        params: { status: ConversationStatus.PENDING }
      }),
    { ...keyboard, enabled: mayChange && mayResolve }
  )
  // Resolving keeps the flow of the header: the reason and the closing message of the store
  useShortcut(Shortcuts.conversation.MARK_RESOLVED, resolve.start, {
    ...keyboard,
    enabled: mayChange && mayResolve && resolve.isReady
  })
  useShortcut(
    Shortcuts.conversation.OPEN_CUSTOMER,
    () => {
      if (detail !== undefined) openCustomer(detail.customer.id)
    },
    { ...keyboard, enabled: isLoaded && can(Permissions.CUSTOMERS_VIEW) }
  )
  useShortcut(Shortcuts.conversation.SNOOZE, openSnooze, {
    ...keyboard,
    enabled: mayChange && can(Permissions.CONVERSATIONS_SNOOZE)
  })

  return (
    <BulkPickDialog
      pick={pick}
      onOpenChange={open => (open ? undefined : setPick(null))}
      onPick={operation => {
        setPick(null)
        run(operation)
      }}
    />
  )
}
