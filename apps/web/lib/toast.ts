import type { ReactNode } from 'react'
import type { ExternalToast } from 'sonner'

// The toasts of the app. `sonner` weighs about 10 KB of the script of every page and nothing needs it
// until the first toast, so it is not loaded with the page: the first toast asks for it, what is asked
// meanwhile waits in a queue, in order, and is shown as soon as the Toaster is mounted. The Toaster is
// the same one as before (position, look, aria-live); only when it arrives changes.
export type ToastKind = 'plain' | 'success' | 'error' | 'info' | 'warning'

export interface ToastCall {
  kind: ToastKind
  message: ReactNode
  options?: ExternalToast | undefined
}

type Show = (call: ToastCall) => void

type Ask = (message: ReactNode, options?: ExternalToast) => void

export interface Toasts {
  toast: Ask & { success: Ask; error: Ask; info: Ask; warning: Ask }
  isRequested: () => boolean
  subscribe: (listener: () => void) => () => void
  // Says how to show a toast and shows the ones that waited; the returned function undoes it
  register: (next: Show) => () => void
  // The load of sonner failed: the next toast asks for it again (what waited stays)
  retry: () => void
}

// How many toasts wait for sonner at most
const MAX_WAITING = 20

export function createToasts(
  isBrowser: () => boolean = () => typeof window !== 'undefined'
): Toasts {
  const waiting: ToastCall[] = []
  const listeners = new Set<() => void>()
  let show: Show | null = null
  let requested = false

  function emit(call: ToastCall): void {
    // A toast is for a person in a browser: on the server nothing would ever show it, and the queue
    // would be shared by every request
    if (!isBrowser()) return
    if (show !== null) {
      show(call)
      return
    }
    waiting.push(call)
    // A page that cannot load sonner must not pile them up without end: the newest are kept
    if (waiting.length > MAX_WAITING) waiting.shift()
    if (!requested) {
      requested = true
      for (const listener of listeners) listener()
    }
  }

  const ask =
    (kind: ToastKind): Ask =>
    (message, options) =>
      emit({ kind, message, options })

  const toast = Object.assign(ask('plain'), {
    success: ask('success'),
    error: ask('error'),
    info: ask('info'),
    warning: ask('warning')
  })

  return {
    toast,
    // The page renders the Toaster once a toast has been asked for
    isRequested: (): boolean => requested,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    // The mounted Toaster says how to show a toast; what waited goes first
    register: (next: Show): (() => void) => {
      show = next
      for (const call of waiting.splice(0)) {
        try {
          next(call)
        } catch {
          // One toast that cannot be shown must not take the ones behind it
        }
      }
      return () => {
        if (show === next) show = null
      }
    },
    retry: (): void => {
      requested = false
    }
  }
}

const toasts = createToasts()
export const toast = toasts.toast
export const isToastRequested = toasts.isRequested
export const subscribeToasts = toasts.subscribe
export const registerToaster = toasts.register
export const retryToasts = toasts.retry
