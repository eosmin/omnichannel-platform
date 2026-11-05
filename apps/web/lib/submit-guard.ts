'use client'

import { useRef } from 'react'

// A flag that is set the moment a form sends and cleared when the request ends. The forms used to refuse
// a second send by reading `isPending` of the mutation, which React Query only shows on the next render:
// two submits in the same tick (the Enter key repeating, a double click) both passed. The flag is checked
// and set in the same call, so only the first one gets in.
export interface SubmitGuard {
  // True for the one send that may go; false while another is in flight
  readonly enter: () => boolean
  // Called when the request ends, with a result or an error
  readonly leave: () => void
}

export function createSubmitGuard(): SubmitGuard {
  let busy = false
  return {
    enter: () => {
      if (busy) return false
      busy = true
      return true
    },
    leave: () => {
      busy = false
    }
  }
}

// One guard for the life of the form. Use it as
// `if (!guard.enter()) return` right before `mutate(input, { onSettled: guard.leave })`; the paths that
// do not send (a field that is wrong, nothing changed) return before it.
export function useSubmitGuard(): SubmitGuard {
  const guard = useRef<SubmitGuard | null>(null)
  guard.current ??= createSubmitGuard()
  return guard.current
}
