'use client'

import { useEffect, useState } from 'react'

// The value, `delayMs` after it stopped changing: a search reads the api once the typing pauses
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}
