'use client'

import { type ReactElement, useEffect, useRef, useState } from 'react'

import { useResolveFlow } from './resolve-flow'

// Resolves one conversation of the list with the flow of the store (the options dialog, or at once with
// the Undo), the same as the header does for the open one. It is mounted for the conversation the key
// was pressed on and asks to be unmounted when the flow is over: at once when the store resolves with
// no questions (the request and its Undo toast outlive this component), or when the dialog closes.
export function RowResolve({
  conversationId,
  onFinished
}: {
  conversationId: string
  onFinished: () => void
}): ReactElement {
  const flow = useResolveFlow(conversationId)
  const [isStarted, setStarted] = useState(false)
  // The effect may run twice on mount (StrictMode): the flow must start once
  const hasStarted = useRef(false)

  useEffect(() => {
    if (hasStarted.current || !flow.isReady) return
    hasStarted.current = true
    flow.start()
    setStarted(true)
  }, [flow])

  // `start` opens the dialog in the same batch that sets `isStarted`, so a started flow with no dialog
  // is one that has nothing left to ask
  useEffect(() => {
    if (isStarted && !flow.isDialogOpen) onFinished()
  }, [isStarted, flow.isDialogOpen, onFinished])

  return flow.dialog
}
