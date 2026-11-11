import { keepShown, NO_SELECTION, toggleAll, toggleOrder } from './order-selection'

describe('the orders selection', () => {
  it('ticks and unticks one row without touching the set it was given', () => {
    const one = toggleOrder(NO_SELECTION, 'a')
    expect([...one]).toEqual(['a'])
    expect(NO_SELECTION.size).toBe(0)
    expect(toggleOrder(one, 'a').size).toBe(0)
  })

  it('ticks all the rows shown, and clears them when all were ticked', () => {
    const all = toggleAll(NO_SELECTION, ['a', 'b'])
    expect([...all].sort()).toEqual(['a', 'b'])
    expect(toggleAll(all, ['a', 'b']).size).toBe(0)
    expect([...toggleAll(new Set(['a']), ['a', 'b'])].sort()).toEqual(['a', 'b'])
    expect(toggleAll(NO_SELECTION, []).size).toBe(0)
  })

  it('keeps only the rows still on the screen', () => {
    const selection = new Set(['a', 'b'])
    expect(keepShown(selection, ['a', 'b', 'c'])).toBe(selection)
    expect([...keepShown(selection, ['b'])]).toEqual(['b'])
  })
})
