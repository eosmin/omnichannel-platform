// The rows a person ticked on the orders page. Step 4.14 turns the selection into the bulk action bar; until then it is
// only kept (and counted), so the page already knows which rows are chosen when the actions arrive.

export type OrderSelection = ReadonlySet<string>

export const NO_SELECTION: OrderSelection = new Set()

export function toggleOrder(selection: OrderSelection, id: string): OrderSelection {
  const next = new Set(selection)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

// "All" is the rows on the screen, not the whole result (a page at a time): ticking it when every row is ticked clears them
export function toggleAll(selection: OrderSelection, shownIds: readonly string[]): OrderSelection {
  const everyShownIsTicked = shownIds.length > 0 && shownIds.every(id => selection.has(id))
  const next = new Set(selection)
  for (const id of shownIds) {
    if (everyShownIsTicked) next.delete(id)
    else next.add(id)
  }
  return next
}

// Only ids still on the screen stay ticked: a row that left the list (a filter changed) is not acted on unseen
export function keepShown(selection: OrderSelection, shownIds: readonly string[]): OrderSelection {
  const shown = new Set(shownIds)
  const kept = [...selection].filter(id => shown.has(id))
  return kept.length === selection.size ? selection : new Set(kept)
}
