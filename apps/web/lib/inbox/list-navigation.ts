// Moving through the list with the keyboard (TDD_09 §9). The rows carry their conversation id in this
// attribute, so the row that has the focus can be told from the document.
export const ROW_ID_ATTRIBUTE = 'data-conversation-id'

export type Direction = 1 | -1

// The row to move to from `currentId` (the focused row, or else the open conversation). It stops at the
// ends instead of wrapping, and from nowhere it lands on the first row.
export function neighborIndex(
  ids: readonly string[],
  currentId: string | undefined,
  direction: Direction
): number | null {
  if (ids.length === 0) return null
  const at = currentId === undefined ? -1 : ids.indexOf(currentId)
  if (at === -1) return 0
  return Math.min(ids.length - 1, Math.max(0, at + direction))
}

// The conversation of the row that holds `element`, if it is inside one
export function rowIdOf(element: Element | null): string | undefined {
  return element?.closest(`[${ROW_ID_ATTRIBUTE}]`)?.getAttribute(ROW_ID_ATTRIBUTE) ?? undefined
}
