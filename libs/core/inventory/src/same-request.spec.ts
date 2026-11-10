import { InventoryMovementType, InventoryReferenceType } from '@platform/core/domain'

import type { MovementInput } from './inventory.types'
import { isSameRequest } from './same-request'

const stored = {
  productId: 'p',
  variantId: null,
  warehouseId: 'w',
  type: InventoryMovementType.RECEIPT,
  quantity: 5,
  reason: null,
  referenceType: null,
  referenceId: null,
  unitCostCents: 200
}
const input: MovementInput = {
  storeId: 's',
  productId: 'p',
  warehouseId: 'w',
  type: InventoryMovementType.RECEIPT,
  quantity: 5,
  idempotencyKey: 'k'
}

describe('isSameRequest', () => {
  it('takes the same request for a retry, with or without the optional fields written as null', () => {
    expect(isSameRequest(stored, input)).toBe(true)
    expect(
      isSameRequest(stored, { ...input, variantId: null, reason: null, unitCostCents: null })
    ).toBe(true)
  })

  it('does not look at the note or at who sent it', () => {
    expect(isSameRequest(stored, { ...input, note: 'again', createdBy: 'someone else' })).toBe(true)
  })

  it.each([
    ['another product', { productId: 'q' }],
    ['a variant', { variantId: 'v' }],
    ['another warehouse', { warehouseId: 'x' }],
    ['another type', { type: InventoryMovementType.ADJUSTMENT_IN }],
    ['another quantity', { quantity: 6 }],
    ['a reason', { reason: 'lost' as never }],
    ['a reference', { reference: { type: InventoryReferenceType.ORDER, id: 'o' } }],
    ['another cost', { unitCostCents: 300 }]
  ])('refuses %s', (_label, change) => {
    expect(isSameRequest(stored, { ...input, ...change })).toBe(false)
  })

  it('reads the cost of a movement that left at the average as no cost given', () => {
    expect(isSameRequest({ ...stored, unitCostCents: 250 }, input)).toBe(true)
  })
})
