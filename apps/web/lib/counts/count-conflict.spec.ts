import { ApiError } from '@platform/api-client'
import { CountConflicts } from '@platform/core/domain'

import { applyRefusalOf, conflictOf } from './count-conflict'

const refusal = (status: number, metadata: Record<string, unknown>) =>
  new ApiError(status, 'X', 'x', null, metadata)

describe('the refusal of an apply', () => {
  it('names the lines the stock cannot cover', () => {
    const error = refusal(409, {
      conflict: CountConflicts.SHORT_STOCK,
      lines: [
        { lineId: 'l1', requested: 4, onHand: 1, storeId: 's' },
        { lineId: 'l2', requested: 2, onHand: null },
        { requested: 9 },
        'junk'
      ]
    })
    expect(applyRefusalOf(error)).toEqual({
      kind: 'short_stock',
      lines: [
        { lineId: 'l1', requested: 4, onHand: 1 },
        { lineId: 'l2', requested: 2, onHand: null }
      ]
    })
  })

  it('names the lines the engine refused and the code it refused them with', () => {
    const error = refusal(409, {
      conflict: CountConflicts.LINES_REFUSED,
      lines: [{ lineId: 'l1', code: 'INVENTORY_NOT_TRACKED' }, { code: 'no line' }]
    })
    expect(applyRefusalOf(error)).toEqual({
      kind: 'lines_refused',
      lines: [{ lineId: 'l1', code: 'INVENTORY_NOT_TRACKED' }]
    })
  })

  it('is null for any other error', () => {
    expect(applyRefusalOf(new Error('x'))).toBeNull()
    expect(
      applyRefusalOf(refusal(403, { conflict: CountConflicts.SHORT_STOCK, lines: [] }))
    ).toBeNull()
    expect(applyRefusalOf(refusal(409, { conflict: CountConflicts.NO_LINES }))).toBeNull()
    expect(
      applyRefusalOf(refusal(409, { conflict: CountConflicts.SHORT_STOCK, lines: 'x' }))
    ).toBeNull()
  })

  it('reads why a create or a start was refused', () => {
    expect(conflictOf(refusal(409, { conflict: CountConflicts.NO_LINES }))).toBe('no_lines')
    expect(conflictOf(refusal(409, {}))).toBeNull()
    expect(conflictOf(refusal(400, { conflict: 'no_lines' }))).toBeNull()
    expect(conflictOf('boom')).toBeNull()
  })
})
