import { moveBy, moveItem, sameOrder } from './routing-order'

const ids = ['a', 'b', 'c', 'd']

describe('moveItem', () => {
  it('puts the item in its new place and keeps the order of the rest', () => {
    expect(moveItem(ids, 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveItem(ids, 3, 0)).toEqual(['d', 'a', 'b', 'c'])
  })

  it('leaves the list as it was for a place outside it or the same place', () => {
    expect(moveItem(ids, 1, 1)).toEqual(ids)
    expect(moveItem(ids, -1, 2)).toEqual(ids)
    expect(moveItem(ids, 1, 4)).toEqual(ids)
    expect(moveItem(ids, 1.5, 2)).toEqual(ids)
  })

  it('never changes the list it was given', () => {
    const original = [...ids]
    moveItem(ids, 0, 3)
    expect(ids).toEqual(original)
  })
})

describe('moveBy', () => {
  it('moves one place up or down', () => {
    expect(moveBy(ids, 'c', -1)).toEqual(['a', 'c', 'b', 'd'])
    expect(moveBy(ids, 'b', 1)).toEqual(['a', 'c', 'b', 'd'])
  })

  it('stays at the ends and for an id that is not in the list', () => {
    expect(moveBy(ids, 'a', -1)).toEqual(ids)
    expect(moveBy(ids, 'd', 1)).toEqual(ids)
    expect(moveBy(ids, 'z', 1)).toEqual(ids)
  })
})

describe('sameOrder', () => {
  it('compares the order, not only the members', () => {
    expect(sameOrder(ids, [...ids])).toBe(true)
    expect(sameOrder(ids, ['b', 'a', 'c', 'd'])).toBe(false)
    expect(sameOrder(ids, ['a', 'b'])).toBe(false)
  })
})
