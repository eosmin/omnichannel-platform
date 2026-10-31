import { neighborIndex } from './list-navigation'

const ids = ['a', 'b', 'c']

describe('neighborIndex', () => {
  it('moves one row either way', () => {
    expect(neighborIndex(ids, 'b', 1)).toBe(2)
    expect(neighborIndex(ids, 'b', -1)).toBe(0)
  })

  it('stops at the ends', () => {
    expect(neighborIndex(ids, 'c', 1)).toBe(2)
    expect(neighborIndex(ids, 'a', -1)).toBe(0)
  })

  it('lands on the first row from nowhere, or from a row that left the list', () => {
    expect(neighborIndex(ids, undefined, 1)).toBe(0)
    expect(neighborIndex(ids, undefined, -1)).toBe(0)
    expect(neighborIndex(ids, 'gone', 1)).toBe(0)
  })

  it('has nowhere to go in an empty list', () => {
    expect(neighborIndex([], undefined, 1)).toBeNull()
  })
})
