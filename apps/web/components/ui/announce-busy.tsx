'use client'

import { useEffect } from 'react'

import { startBusy } from '../../lib/busy-announcer'

// Drawn by a `Button` while it waits for the server: draws nothing and counts the button for the region of the
// app that tells a screen reader (`BusyAnnouncer`)
export function AnnounceBusy(): null {
  useEffect(() => startBusy(), [])
  return null
}
