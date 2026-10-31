'use client'

import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useMemo,
  useState
} from 'react'

import { ConversationShortcuts } from './conversation-shortcuts'
import { type ResolveFlow, useResolveFlow } from './resolve-flow'
import { SnoozeDialog } from './snooze-dialog'

interface ConversationControlsValue {
  resolve: Pick<ResolveFlow, 'isReady' | 'start'>
  openSnooze: () => void
}

const ConversationControlsContext = createContext<ConversationControlsValue | null>(null)

// The two things that change the state of the open conversation and have a dialog: snooze and
// resolve. The header and the composer both start them, so there is one of each here: a second copy
// would not know that the first is already resolving.
export function ConversationControls({
  conversationId,
  children
}: {
  conversationId: string
  children: ReactNode
}): ReactElement {
  const resolve = useResolveFlow(conversationId)
  const [isSnoozeOpen, setSnoozeOpen] = useState(false)
  const { isReady, start, dialog } = resolve
  const value = useMemo<ConversationControlsValue>(
    () => ({ resolve: { isReady, start }, openSnooze: () => setSnoozeOpen(true) }),
    [isReady, start]
  )
  return (
    <ConversationControlsContext.Provider value={value}>
      {children}
      <ConversationShortcuts conversationId={conversationId} />
      <SnoozeDialog
        open={isSnoozeOpen}
        onOpenChange={setSnoozeOpen}
        conversationId={conversationId}
      />
      {dialog}
    </ConversationControlsContext.Provider>
  )
}

export function useConversationControls(): ConversationControlsValue {
  const value = useContext(ConversationControlsContext)
  if (value === null) throw new Error('useConversationControls needs ConversationControls above it')
  return value
}
