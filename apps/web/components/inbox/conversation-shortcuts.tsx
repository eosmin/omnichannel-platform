'use client'

import { useRouter } from 'next/navigation'
import { type ReactElement, useEffect, useState } from 'react'

import { type BulkOperation, AppPaths } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { BulkActions, ConversationStatus, Shortcuts } from '@platform/core/domain'

import { canChangeState } from '../../lib/inbox/conversation-status'
import { useBulkRunner } from '../../lib/inbox/use-bulk-actions'
import { useCustomerNamer } from '../../lib/inbox/use-customer-name'
import { useConversation } from '../../lib/inbox/use-inbox-data'
import { useInboxFilters } from '../../lib/inbox/use-inbox-filters'
import { ShortcutPriority } from '../../lib/shortcuts/priorities'
import { useMountedOnce } from '../../lib/use-mounted-once'
import { useCustomerDrawer } from '../customers/customer-drawer-context'
import { useStore } from '../providers/store-context'
import { useShortcut } from '../shortcuts/shortcuts-provider'

import { type BulkPick, BulkPicks } from './bulk-picks'
import { useConversationControls } from './conversation-controls'
import { BulkPickDialog } from './lazy-dialogs'
import { otherResolveMode } from './resolve-flow'

// How long a key pressed before the settings of the store arrive waits for them
const RESOLVE_WAIT_MS = 5000

// The keys of the open conversation (TDD_09 §9). Each works only where its button would be offered: with
// its permission and in a state that allows it. The reply box and the note keys are the composer's.
// Changes go through the same runner as the bulk bar, so the toast and the Undo are the same.
export function ConversationShortcuts({
  conversationId
}: {
  conversationId: string
}): ReactElement | null {
  const router = useRouter()
  const { storeId, can } = useStore()
  const { search } = useInboxFilters()
  const conversation = useConversation(storeId, conversationId)
  const runner = useBulkRunner()
  const nameOf = useCustomerNamer()
  const { openCustomer } = useCustomerDrawer()
  const { resolve, openSnooze } = useConversationControls()
  const [pick, setPick] = useState<BulkPick | null>(null)
  const isPickMounted = useMountedOnce(pick !== null)

  const detail = conversation.data
  const isLoaded = detail !== undefined
  const mayChange = isLoaded && canChangeState(detail.status)
  const mayAssign =
    can(ClientPermissions.CONVERSATIONS_RESOLVE) || can(ClientPermissions.CONVERSATIONS_ASSIGN)
  const mayResolve = can(ClientPermissions.CONVERSATIONS_RESOLVE)

  // The way of resolving a key asked for while the flow was not ready: the main one (`e`) or the other (`Shift+E`),
  // for the conversation it was pressed on
  const [resolveWaiting, setResolveWhenReady] = useState<{
    way: 'default' | 'other'
    conversationId: string
  } | null>(null)
  const { isReady: isResolveReady, start: startResolve, startWith: startResolveWith } = resolve
  const { defaultMode: resolveDefaultMode } = resolve
  // The key waits only a short while, for this conversation and while the agent may still resolve it: a request
  // that outlives that (the settings were slow, the conversation changed or was closed meanwhile) is dropped, so
  // that a resolve never starts that the agent did not ask for at that moment
  useEffect(() => {
    if (resolveWaiting === null) return undefined
    const timer = setTimeout(() => setResolveWhenReady(null), RESOLVE_WAIT_MS)
    return () => clearTimeout(timer)
  }, [resolveWaiting])
  useEffect(() => setResolveWhenReady(null), [conversationId])
  useEffect(() => {
    if (resolveWaiting === null || !isResolveReady) return
    setResolveWhenReady(null)
    // A request made on another conversation is dropped, even in the render where the conversation changed
    if (resolveWaiting.conversationId !== conversationId || !mayChange || !mayResolve) return
    if (resolveWaiting.way === 'default') startResolve()
    else startResolveWith(otherResolveMode(resolveDefaultMode))
  }, [
    resolveWaiting,
    isResolveReady,
    startResolve,
    startResolveWith,
    resolveDefaultMode,
    conversationId,
    mayChange,
    mayResolve
  ])

  const run = (operation: BulkOperation): void => {
    if (detail === undefined || !runner.claim()) return
    void runner.run(
      operation,
      { conversationIds: [conversationId] },
      [detail],
      nameOf(detail.customer, detail.anonymousCustomers)
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
    enabled: isLoaded && can(ClientPermissions.CONVERSATIONS_ASSIGN)
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
  // Resolving keeps the flow of the header: the reason and the closing message of the store. The flow needs the
  // settings of the store; a key pressed before they arrive (either of the two) is not lost: the flow starts when they do.
  useShortcut(
    Shortcuts.conversation.MARK_RESOLVED,
    () => {
      if (resolve.isReady) resolve.start()
      else setResolveWhenReady({ way: 'default', conversationId })
    },
    { ...keyboard, enabled: mayChange && mayResolve }
  )
  // The other way to resolve than the main button's: the dialog if the store resolves at once, and the reverse
  useShortcut(
    Shortcuts.conversation.MARK_RESOLVED_OTHER_WAY,
    () => {
      if (resolve.isReady) resolve.startWith(otherResolveMode(resolve.defaultMode))
      else setResolveWhenReady({ way: 'other', conversationId })
    },
    { ...keyboard, enabled: mayChange && mayResolve }
  )
  useShortcut(
    Shortcuts.conversation.OPEN_CUSTOMER,
    () => {
      if (detail !== undefined) openCustomer(detail.customer.id)
    },
    { ...keyboard, enabled: isLoaded && can(ClientPermissions.CUSTOMERS_VIEW) }
  )
  useShortcut(Shortcuts.conversation.SNOOZE, openSnooze, {
    ...keyboard,
    enabled: mayChange && can(ClientPermissions.CONVERSATIONS_SNOOZE)
  })

  return isPickMounted ? (
    <BulkPickDialog
      pick={pick}
      onOpenChange={open => (open ? undefined : setPick(null))}
      onPick={operation => {
        setPick(null)
        run(operation)
      }}
    />
  ) : null
}
