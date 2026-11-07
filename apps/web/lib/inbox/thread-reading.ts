// What the reader of a thread has and has not seen, as plain functions of the list and the scroll

// How many messages come after the last one the reader reached (ids in the order of the thread). A mark
// that is not in the list counts nothing: it is an older page, or another conversation.
export function unseenAfter(ids: readonly string[], seenUpTo: string | null): number {
  if (seenUpTo === null) return 0
  const at = ids.indexOf(seenUpTo)
  return at === -1 ? 0 : ids.length - at - 1
}

// The day the top of the view is inside: the last day whose block began at or above it. `days` are in the
// order of the thread, with the place of each separator from the top of the content.
export function stickyDayOf(
  days: readonly { key: string; top: number }[],
  viewTop: number
): string | null {
  let current: string | null = null
  for (const day of days) {
    if (day.top <= viewTop) current = day.key
    else break
  }
  return current
}
