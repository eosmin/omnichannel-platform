// Reading a list of the worker page by page (see worker-lists.ts)

export const WorkerListPage = { SIZE: 500 } as const

// Walks a keyed list to its end. `fetch` returns the rows after the key, at most `size`; a page shorter than `size` is the last.
// The key of a row is its position in the order of the function, so the same row can never be read twice or skipped.
export async function readAllPages<T>(
  fetch: (after: string | null, size: number) => Promise<T[]>,
  keyOf: (row: T) => string,
  size: number = WorkerListPage.SIZE
): Promise<T[]> {
  const all: T[] = []
  let after: string | null = null
  for (;;) {
    const page: T[] = await fetch(after, size)
    all.push(...page)
    if (page.length < size) return all
    const last = page.at(-1)
    if (last === undefined) return all
    const next = keyOf(last)
    // A key that does not advance would loop for ever; the order of every function is strictly by the key
    if (next === after) throw new Error('a list of the worker did not advance')
    after = next
  }
}
