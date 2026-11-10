import { ApiError } from '@platform/api-client'
import { ProductConflicts } from '@platform/core/domain'

import { conflictOf, historyCountsOf } from './product-conflict'

const conflict = (metadata: Record<string, unknown>, code = 'RESOURCE_CONFLICT'): ApiError =>
  new ApiError(409, code, 'x', null, metadata)

describe('conflictOf', () => {
  it.each(Object.values(ProductConflicts))('reads %s from the metadata of a 409', value => {
    expect(conflictOf(conflict({ conflict: value }))).toBe(value)
  })

  it('is null for a conflict of another kind, another code or no api error at all', () => {
    expect(conflictOf(conflict({ conflict: 'something_else' }))).toBeNull()
    expect(conflictOf(conflict({}))).toBeNull()
    expect(
      conflictOf(conflict({ conflict: ProductConflicts.SKU_IN_USE }, 'VALIDATION_FAILED'))
    ).toBeNull()
    expect(conflictOf(new Error('x'))).toBeNull()
  })
})

describe('historyCountsOf', () => {
  it('reads the counts the refusal names and zero for the rest', () => {
    expect(
      historyCountsOf(
        conflict({
          conflict: ProductConflicts.HAS_HISTORY,
          orderItems: 3,
          inventoryLevels: 2,
          media: 1
        })
      )
    ).toEqual({ orderItems: 3, inventoryMovements: 0, inventoryLevels: 2, media: 1 })
  })

  it('ignores a value that is not a count', () => {
    expect(
      historyCountsOf(
        conflict({ orderItems: '3', media: -2, inventoryMovements: 1.5, inventoryLevels: 0 })
      )
    ).toEqual({
      orderItems: 0,
      inventoryMovements: 0,
      inventoryLevels: 0,
      media: 0
    })
    expect(historyCountsOf(null)).toEqual({
      orderItems: 0,
      inventoryMovements: 0,
      inventoryLevels: 0,
      media: 0
    })
  })
})
