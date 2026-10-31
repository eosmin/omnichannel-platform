import {
  EMPTY_SELECTION,
  isEmpty,
  retainLoaded,
  selectAllMatching,
  selectIds,
  toggleId
} from './selection'

describe('selection', () => {
  it('ticks and unticks a row without touching the previous selection', () => {
    const one = toggleId(EMPTY_SELECTION, 'a')
    const two = toggleId(one, 'b')
    const back = toggleId(two, 'a')

    expect([...one.ids]).toEqual(['a'])
    expect([...two.ids]).toEqual(['a', 'b'])
    expect([...back.ids]).toEqual(['b'])
    expect(EMPTY_SELECTION.ids.size).toBe(0)
  })

  it('ends "all matching" when a single row changes', () => {
    const all = selectAllMatching(selectIds(['a', 'b']))
    expect(all.isAllMatching).toBe(true)
    expect(toggleId(all, 'a').isAllMatching).toBe(false)
  })

  it('is empty only with no ids and no "all matching"', () => {
    expect(isEmpty(EMPTY_SELECTION)).toBe(true)
    expect(isEmpty(selectIds(['a']))).toBe(false)
    expect(isEmpty(selectAllMatching(EMPTY_SELECTION))).toBe(false)
  })

  it('drops the rows that left the list and keeps the same object when none did', () => {
    const selection = selectAllMatching(selectIds(['a', 'b']))

    expect(retainLoaded(selection, new Set(['a', 'b', 'c']))).toBe(selection)

    const some = retainLoaded(selection, new Set(['a']))
    expect([...some.ids]).toEqual(['a'])
    expect(some.isAllMatching).toBe(true)

    const none = retainLoaded(selection, new Set(['z']))
    expect(none.ids.size).toBe(0)
    expect(none.isAllMatching).toBe(false)
  })
})
