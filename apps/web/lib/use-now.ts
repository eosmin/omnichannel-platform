'use client'

import { useEffect, useState } from 'react'

// The current time, read again every `everyMs` while `active`. It lets "5 min ago" in an open panel
// move on without a refetch. Inactive, nothing runs.
export function useNow(everyMs: number, active: boolean): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    if (!active) return undefined
    // The panel may have been closed for a while: catch up at once, then tick
    setNow(new Date())
    const timer = setInterval(() => setNow(new Date()), everyMs)
    return () => clearInterval(timer)
  }, [everyMs, active])
  return now
}
