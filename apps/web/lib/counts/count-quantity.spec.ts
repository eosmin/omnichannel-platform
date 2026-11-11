import { CountLimits } from '@platform/core/domain'

import { parseCountedQuantity } from './count-quantity'

describe('parseCountedQuantity', () => {
  it.each([
    ['0', 0],
    ['7', 7],
    ['  12 ', 12],
    ['007', 7],
    [String(CountLimits.MAX_COUNTED_QUANTITY), CountLimits.MAX_COUNTED_QUANTITY]
  ])('reads %p as %p', (text, value) => {
    expect(parseCountedQuantity(text)).toEqual({ kind: 'ok', value })
  })

  it('takes an empty field as "not counted", which is not zero', () => {
    expect(parseCountedQuantity('')).toEqual({ kind: 'empty' })
    expect(parseCountedQuantity('   ')).toEqual({ kind: 'empty' })
  })

  it.each(['-1', '1.5', '1,5', 'ten', '1e3', '+3', '0x10', '١٢', '1234567890'])(
    'refuses %p instead of rounding it',
    text => {
      expect(parseCountedQuantity(text)).toEqual({ kind: 'invalid' })
    }
  )

  it('refuses what is over the ceiling of a movement', () => {
    expect(parseCountedQuantity(String(CountLimits.MAX_COUNTED_QUANTITY + 1))).toEqual({
      kind: 'invalid'
    })
  })
})
