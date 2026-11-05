// Where the focus goes back to when a dialog closes. Radix returns it to the dialog's own trigger and
// to nothing else; every dialog of this app is opened by state from a plain button, so without this the
// focus fell to `<body>` and a keyboard user lost their place on the page (QA CAN-17).

// What of an element the helpers need; a real HTMLElement satisfies it, and a spec can pass a stub
export interface FocusTarget {
  readonly isConnected: boolean
  readonly focus: () => void
}

interface FocusableEvent {
  readonly defaultPrevented: boolean
  readonly preventDefault: () => void
}

// The element that holds the focus when the dialog opens, if it is something that can take it back
export function openerOf(active: unknown): FocusTarget | null {
  if (typeof active !== 'object' || active === null) return null
  const candidate = active as Partial<FocusTarget> & { tagName?: unknown }
  // `<body>` holds the focus when nothing does: returning there is what Radix already does
  if (candidate.tagName === 'BODY') return null
  return typeof candidate.focus === 'function' && candidate.isConnected !== undefined
    ? (candidate as FocusTarget)
    : null
}

// Gives the focus back to the opener and tells Radix to leave it alone, but only when the opener took it
// (`holdsFocus` says who has it now): a button that is disabled, hidden or inert ignores `focus()`, and
// then the event is left as it came, as it was before. When the opener left the page, the same.
export function returnFocus(
  event: FocusableEvent,
  opener: FocusTarget | null,
  holdsFocus: (target: FocusTarget) => boolean
): boolean {
  if (event.defaultPrevented || opener === null || !opener.isConnected) return false
  opener.focus()
  if (!holdsFocus(opener)) return false
  event.preventDefault()
  return true
}
