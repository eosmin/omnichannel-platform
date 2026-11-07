'use client'

import type { ReactElement } from 'react'
import { useEffect } from 'react'
import { toast as sonner } from 'sonner'

import { registerToaster, type ToastCall } from '../../lib/toast'

import { Toaster } from './sonner'

function show(call: ToastCall): void {
  if (call.kind === 'plain') sonner(call.message, call.options)
  else sonner[call.kind](call.message, call.options)
}

// The Toaster has to be in the page, with its live region, before the first toast is put in it, or a
// screen reader does not announce it: the queue is handed over a moment after the Toaster mounted
const LIVE_REGION_DELAY_MS = 100

// The Toaster with sonner behind it, loaded when the first toast is asked for (`ToasterHost`). Its own
// effect (that of the child) subscribes before this one runs, so what waited is not lost.
export default function LoadedToaster(): ReactElement {
  useEffect(() => {
    let stop: (() => void) | undefined
    const timer = setTimeout(() => {
      stop = registerToaster(show)
    }, LIVE_REGION_DELAY_MS)
    return () => {
      clearTimeout(timer)
      stop?.()
    }
  }, [])
  return <Toaster />
}
