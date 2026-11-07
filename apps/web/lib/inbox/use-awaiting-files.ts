import { useEffect, useState } from 'react'

import { awaitsFiles, MediaArrival } from './media-state'

// Whether a message is a customer's file whose file has not been stored yet (`awaitsFiles`). The window ends by
// itself: when it does, the message is drawn again as the word of its kind, even in a thread nobody touches, so
// a file that never comes does not pulse for ever.
export function useAwaitingFiles(message: Parameters<typeof awaitsFiles>[0]): boolean {
  const [nowMs, setNowMs] = useState(() => Date.now())
  const awaiting = awaitsFiles(message, nowMs)
  const sentAt = Date.parse(message.createdAt)
  useEffect(() => {
    if (!awaiting) return undefined
    const left = sentAt + MediaArrival.WINDOW_MS - Date.now()
    const timer = setTimeout(() => setNowMs(Date.now()), Math.max(0, left) + 50)
    return () => clearTimeout(timer)
  }, [awaiting, sentAt])
  return awaiting
}
