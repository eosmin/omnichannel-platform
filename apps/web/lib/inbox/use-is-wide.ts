'use client'

import { useSyncExternalStore } from 'react'

// The width from which the inbox has room for the sidebar (`xl` of Tailwind)
const SIDEBAR_MIN_WIDTH_PX = 1280
const QUERY = `(min-width: ${SIDEBAR_MIN_WIDTH_PX}px)`

function subscribe(listener: () => void): () => void {
  const media = window.matchMedia(QUERY)
  media.addEventListener('change', listener)
  return () => media.removeEventListener('change', listener)
}

// False on the server and until the browser answers, so a narrow screen never mounts what it hides
export function useHasRoomForSidebar(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false
  )
}
