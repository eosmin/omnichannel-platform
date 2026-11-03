'use client'

import { createContext, type MutableRefObject, useContext, useEffect } from 'react'

// How many forms of the page hold changes that were not saved. The settings frame creates it, asks it
// before a link of its own navigation leaves the page, and each form raises it through the hook.
export const UnsavedChangesContext = createContext<MutableRefObject<number> | null>(null)

// Tells the page that this form holds changes nobody saved: the browser asks before the tab is
// closed or reloaded, and the settings navigation asks before it leaves for another page. Moving the
// browser's back button, or the store navigation outside the frame, are not covered (see the plan).
export function useUnsavedChanges(dirty: boolean): void {
  const counter = useContext(UnsavedChangesContext)
  useEffect(() => {
    if (!dirty) return undefined
    const warn = (event: BeforeUnloadEvent): void => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    if (counter !== null) counter.current += 1
    return () => {
      window.removeEventListener('beforeunload', warn)
      if (counter !== null) counter.current -= 1
    }
  }, [dirty, counter])
}
