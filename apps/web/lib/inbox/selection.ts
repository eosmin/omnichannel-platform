// The conversations ticked in the list (TDD_09 §10). `isAllMatching` is "select all matching this
// filter": the action then goes to the server as the filter, not as the ids, and reaches what the
// list has not loaded yet.
export interface Selection {
  ids: ReadonlySet<string>
  isAllMatching: boolean
}

export const EMPTY_SELECTION: Selection = { ids: new Set(), isAllMatching: false }

export function toggleId(selection: Selection, id: string): Selection {
  const ids = new Set(selection.ids)
  if (!ids.delete(id)) ids.add(id)
  // Changing one row ends "all matching": the agent is picking again
  return { ids, isAllMatching: false }
}

export function selectIds(ids: readonly string[]): Selection {
  return { ids: new Set(ids), isAllMatching: false }
}

// Keeps the ticked rows and widens the action to everything the filter matches
export function selectAllMatching(selection: Selection): Selection {
  return { ids: selection.ids, isAllMatching: true }
}

export function isEmpty(selection: Selection): boolean {
  return selection.ids.size === 0 && !selection.isAllMatching
}

// A row that left the list (resolved under a filter, assigned to someone else) is no longer ticked:
// an action must not reach a conversation the agent can no longer see. The same object comes back
// when nothing changed, so a state that holds it does not render again.
export function retainLoaded(selection: Selection, loaded: ReadonlySet<string>): Selection {
  if ([...selection.ids].every(id => loaded.has(id))) return selection
  const ids = new Set([...selection.ids].filter(id => loaded.has(id)))
  return { ids, isAllMatching: ids.size === 0 ? false : selection.isAllMatching }
}
