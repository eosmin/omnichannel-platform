import type { MovementInput, MovementRecord } from './inventory.types'

// A key is one request (TDD_16 §4.2): the same key with the same item, warehouse, type, quantity, reason, reference
// and cost (when one is given) is a retry and answers what the first one did; any other body under it is a mistake
// and is refused. The note and the author are not part of the request: a retry may come from another session.
export function isSameRequest(
  stored: Pick<
    MovementRecord,
    | 'productId'
    | 'variantId'
    | 'warehouseId'
    | 'type'
    | 'quantity'
    | 'reason'
    | 'referenceType'
    | 'referenceId'
    | 'unitCostCents'
  >,
  input: MovementInput
): boolean {
  return (
    stored.productId === input.productId &&
    stored.variantId === (input.variantId ?? null) &&
    stored.warehouseId === input.warehouseId &&
    stored.type === input.type &&
    stored.quantity === input.quantity &&
    stored.reason === (input.reason ?? null) &&
    stored.referenceType === (input.reference?.type ?? null) &&
    stored.referenceId === (input.reference?.id ?? null) &&
    (input.unitCostCents === undefined ||
      input.unitCostCents === null ||
      stored.unitCostCents === input.unitCostCents)
  )
}
