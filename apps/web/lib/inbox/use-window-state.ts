'use client'

import { useEffect, useState } from 'react'

import { useMessagingWindow } from './use-inbox-data'
import { type WindowState, windowStateOf } from './window-state'

const TICK_MS = 60_000

// The state of the messaging window with the clock running: the minutes left change on their own, and
// the moment the window ends the answer is read again, because only the server knows whether a
// template can follow. A timer is capped by what setTimeout can count, so a window days away is
// simply checked again at the next tick.
export function useWindowState(storeId: string, conversationId: string): WindowState {
  const view = useMessagingWindow(storeId, conversationId)
  const [now, setNow] = useState(() => new Date())
  const { data, refetch } = view

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), TICK_MS)
    return () => clearInterval(timer)
  }, [])

  const closesAt = data?.open === true && data.closesAt !== null ? Date.parse(data.closesAt) : null
  // At the moment the window ends the answer is read again. If the server still says it is open (a
  // clock that runs ahead of ours), the effect runs again with the next tick and asks once more, so
  // the state never stays at "nothing left" for good.
  useEffect(() => {
    if (closesAt === null) return
    const wait = closesAt - Date.now()
    if (wait > TICK_MS) return
    const timer = setTimeout(() => void refetch(), Math.max(wait, 0))
    return () => clearTimeout(timer)
  }, [closesAt, now, refetch])

  return windowStateOf(data, now)
}
