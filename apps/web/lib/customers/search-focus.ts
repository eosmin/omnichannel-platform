// Who goes to the page of customers and wants the cursor in its search box says so before the jump
// (`Mod+K`, the Find customer action of the inbox); the page takes the request once, when it opens. A jump
// that does not ask (`g c`, the navigation link) leaves the focus where the page puts it: with the cursor
// in a text field the shortcuts are off, so a person who uses only the keyboard could not leave with `g i`.
// A request that the page does not take soon (the jump was cancelled, a link opened in another tab) expires,
// so that it cannot give the cursor to a later visit that did not ask for it.
export const SEARCH_FOCUS_REQUEST_TTL_MS = 3000

let askedAt: number | null = null

export function askSearchFocus(): void {
  askedAt = Date.now()
}

// True once for each request, while it is fresh
export function takeSearchFocus(): boolean {
  const wasAskedAt = askedAt
  askedAt = null
  return wasAskedAt !== null && Date.now() - wasAskedAt <= SEARCH_FOCUS_REQUEST_TTL_MS
}
