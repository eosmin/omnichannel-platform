import { CountLimits, InventoryMovementType } from '@platform/core/domain'

import { countMovementKey, countNumber, movementOf, sequenceOf, varianceOf } from './counts.rules'

describe('varianceOf', () => {
  it('is the counted quantity minus the snapshot', () => {
    expect(varianceOf({ expectedQuantity: 10, countedQuantity: 8 })).toBe(-2)
    expect(varianceOf({ expectedQuantity: 10, countedQuantity: 13 })).toBe(3)
    expect(varianceOf({ expectedQuantity: 10, countedQuantity: 10 })).toBe(0)
  })

  it('is unknown, not zero, for a line nobody counted', () => {
    expect(varianceOf({ expectedQuantity: 10, countedQuantity: null })).toBeNull()
  })

  it('treats a counted zero as a count', () => {
    expect(varianceOf({ expectedQuantity: 4, countedQuantity: 0 })).toBe(-4)
  })
})

describe('movementOf', () => {
  it('writes COUNT_OUT of the missing units', () => {
    expect(movementOf({ expectedQuantity: 10, countedQuantity: 8 })).toEqual({
      type: InventoryMovementType.COUNT_OUT,
      quantity: 2
    })
  })

  it('writes COUNT_IN of the extra units', () => {
    expect(movementOf({ expectedQuantity: 10, countedQuantity: 13 })).toEqual({
      type: InventoryMovementType.COUNT_IN,
      quantity: 3
    })
  })

  it('writes nothing for no variance or no count', () => {
    expect(movementOf({ expectedQuantity: 10, countedQuantity: 10 })).toBeNull()
    expect(movementOf({ expectedQuantity: 10, countedQuantity: null })).toBeNull()
  })
})

describe('countMovementKey', () => {
  it('is deterministic and names the count and the line', () => {
    expect(countMovementKey('c1', 'l1')).toBe('count:c1:l1')
    expect(countMovementKey('c1', 'l1')).toBe(countMovementKey('c1', 'l1'))
    expect(countMovementKey('c1', 'l2')).not.toBe(countMovementKey('c1', 'l1'))
  })
})

describe('count numbers', () => {
  it('pads to four digits and grows past them', () => {
    expect(countNumber(1)).toBe('CT-0001')
    expect(countNumber(9999)).toBe('CT-9999')
    expect(countNumber(10000)).toBe('CT-10000')
  })

  it('reads the sequence back and refuses what is not a number of ours', () => {
    expect(sequenceOf('CT-0042')).toBe(42)
    expect(sequenceOf('CT-10000')).toBe(10000)
    expect(sequenceOf('XX-0042')).toBeNull()
    expect(sequenceOf(`${CountLimits.NUMBER_PREFIX}12a`)).toBeNull()
    expect(sequenceOf(CountLimits.NUMBER_PREFIX)).toBeNull()
  })
})
