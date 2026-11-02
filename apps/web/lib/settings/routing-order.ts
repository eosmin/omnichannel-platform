// The order of the rules is the order they are tried in (TDD_09 §13): the first that matches a new
// conversation wins. These functions only compute the new list of ids; the api stores it.

// Moves the item at `from` to the place `to`, the rest keep their order. An index outside the list
// leaves it as it was.
export function moveItem(ids: readonly string[], from: number, to: number): string[] {
  const inside = (index: number): boolean =>
    Number.isInteger(index) && index >= 0 && index < ids.length
  if (!inside(from) || !inside(to) || from === to) return [...ids]
  const next = [...ids]
  const [moved] = next.splice(from, 1)
  if (moved === undefined) return [...ids]
  next.splice(to, 0, moved)
  return next
}

// One place up (-1) or down (+1): what the keyboard buttons do. At the end of the list it stays.
export function moveBy(ids: readonly string[], id: string, delta: -1 | 1): string[] {
  const from = ids.indexOf(id)
  if (from === -1) return [...ids]
  const to = from + delta
  return to < 0 || to >= ids.length ? [...ids] : moveItem(ids, from, to)
}

export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}
