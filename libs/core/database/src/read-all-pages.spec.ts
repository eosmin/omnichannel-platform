import { readAllPages } from './read-all-pages'

describe('readAllPages', () => {
  const rows = ['a', 'b', 'c', 'd', 'e']
  const page = (after: string | null, size: number): Promise<string[]> =>
    Promise.resolve(rows.filter(row => after === null || row > after).slice(0, size))

  it('walks the pages to the end, with no row twice or skipped', async () => {
    expect(await readAllPages(page, id => id, 2)).toEqual(rows)
    // an exact multiple of the page size ends with an empty page
    expect(await readAllPages(page, id => id, 5)).toEqual(rows)
    expect(await readAllPages(page, id => id, 50)).toEqual(rows)
  })

  it('returns an empty list for an empty table', async () => {
    expect(
      await readAllPages(
        () => Promise.resolve([]),
        id => String(id),
        3
      )
    ).toEqual([])
  })

  it('fails when a page fails, instead of returning the rows read so far', async () => {
    let calls = 0
    const failing = (after: string | null, size: number): Promise<string[]> => {
      calls += 1
      if (calls === 2) return Promise.reject(new Error('the database went away'))
      return page(after, size)
    }
    await expect(readAllPages(failing, id => id, 2)).rejects.toThrow('went away')
  })

  it('refuses a list whose key does not advance', async () => {
    await expect(
      readAllPages(
        () => Promise.resolve(['x', 'x']),
        id => id,
        2
      )
    ).rejects.toThrow('did not advance')
  })
})
