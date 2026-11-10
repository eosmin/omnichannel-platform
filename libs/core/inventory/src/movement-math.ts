import {
  InventoryMovementEffects,
  InventoryMovementType,
  InventoryMovementsThatBringUnitsIn
} from '@platform/core/domain'

// The rules of one movement on one level, with no database (TDD_16 §3, §4.2, §4.10): what the level becomes, at what
// cost the units moved, or why the movement is refused. InventoryService reads the level under a row lock, asks this,
// and writes what it answers. Money is whole USD cents; the value of a level can outgrow 32 bits, so it is a bigint.

export interface LevelState {
  onHand: number
  reserved: number
  // What the units on hand are worth at their cost: the weighted average is valueCents / onHand
  valueCents: bigint
}

export type Refusal =
  // Reserve or transfer out: not enough available (onHand - reserved)
  | { kind: 'insufficient_available'; available: number }
  // Issue, adjustment out, count out: it would leave less than nothing on hand
  | { kind: 'insufficient_on_hand'; onHand: number }
  // Release or issue for more units than are reserved
  | { kind: 'reservation_exceeded'; reserved: number }

export type Plan =
  { ok: true; next: LevelState; unitCostCents: number | null } | { ok: false; refusal: Refusal }

export interface PlanOptions {
  // StoreSettings.allowNegativeStock (TDD_16 §4.10)
  allowNegativeStock: boolean
  // The cost of one unit that comes in, when the caller knows it
  unitCostCents: number | null
  // Apply the movement whatever the rules say: the replay of a ledger, which is what happened
  force?: boolean
}

// a / b rounded half up, for a >= 0 and b > 0
export function roundedDivision(a: bigint, b: bigint): bigint {
  return (2n * a + b) / (2n * b)
}

const bringsUnitsIn = (type: InventoryMovementType): boolean =>
  InventoryMovementsThatBringUnitsIn.includes(type)

export function planMovement(
  level: LevelState,
  type: InventoryMovementType,
  quantity: number,
  options: PlanOptions
): Plan {
  const effect = InventoryMovementEffects[type]
  const onHand = level.onHand + effect.onHand * quantity
  const reserved = level.reserved + effect.reserved * quantity
  const available = level.onHand - level.reserved

  const refusal = options.force
    ? null
    : refusalOf(type, level, quantity, available, onHand, options.allowNegativeStock)
  if (refusal !== null) return { ok: false, refusal }

  if (bringsUnitsIn(type)) {
    // No cost given: the units come in at what the level already averages, so the average does not move
    const average =
      level.onHand > 0 && level.valueCents > 0n
        ? roundedDivision(level.valueCents, BigInt(level.onHand))
        : 0n
    const unitCost = options.unitCostCents === null ? average : BigInt(options.unitCostCents)
    // A deficit is covered first: only the units that end above zero carry value
    const valueCents =
      level.onHand >= 0
        ? level.valueCents + BigInt(quantity) * unitCost
        : onHand > 0
          ? BigInt(onHand) * unitCost
          : 0n
    return {
      ok: true,
      next: { onHand, reserved, valueCents },
      unitCostCents: options.unitCostCents
    }
  }

  if (effect.onHand < 0) {
    // Units leave at the average cost of the level; with none on hand there is no cost to take
    if (level.onHand <= 0) {
      return { ok: true, next: { onHand, reserved, valueCents: 0n }, unitCostCents: null }
    }
    const unitCostCents = Number(roundedDivision(level.valueCents, BigInt(level.onHand)))
    const leaving = Math.min(quantity, level.onHand)
    const removed =
      leaving === level.onHand
        ? level.valueCents
        : roundedDivision(level.valueCents * BigInt(leaving), BigInt(level.onHand))
    const valueCents = onHand <= 0 ? 0n : level.valueCents - removed
    return { ok: true, next: { onHand, reserved, valueCents }, unitCostCents }
  }

  // Reserve and release move no value
  return { ok: true, next: { onHand, reserved, valueCents: level.valueCents }, unitCostCents: null }
}

function refusalOf(
  type: InventoryMovementType,
  level: LevelState,
  quantity: number,
  available: number,
  onHandAfter: number,
  allowNegativeStock: boolean
): Refusal | null {
  switch (type) {
    case InventoryMovementType.RESERVE:
      return !allowNegativeStock && quantity > available
        ? { kind: 'insufficient_available', available }
        : null
    case InventoryMovementType.RELEASE:
      return quantity > level.reserved
        ? { kind: 'reservation_exceeded', reserved: level.reserved }
        : null
    case InventoryMovementType.ISSUE:
      if (quantity > level.reserved)
        return { kind: 'reservation_exceeded', reserved: level.reserved }
      return !allowNegativeStock && onHandAfter < 0
        ? { kind: 'insufficient_on_hand', onHand: level.onHand }
        : null
    case InventoryMovementType.ADJUSTMENT_OUT:
    case InventoryMovementType.COUNT_OUT:
      return !allowNegativeStock && onHandAfter < 0
        ? { kind: 'insufficient_on_hand', onHand: level.onHand }
        : null
    case InventoryMovementType.TRANSFER_OUT:
      // A physical shipment cannot exceed what is on the shelf and not promised: the setting does not apply
      return quantity > available ? { kind: 'insufficient_available', available } : null
    default:
      return null
  }
}

// One row of the ledger as the replay reads it
export interface LedgerRow {
  type: InventoryMovementType
  quantity: number
  unitCostCents: number | null
}

// What a level must be, from its ledger alone, in the order the ledger was written (`seq`): the reconciliation job
// compares this with the level (TDD_16 §4.8). A movement the engine refused is never in the ledger, so a row that
// the rules would refuse now (a setting turned off since) is applied as written: the ledger is what happened. The value
// follows the same weighted-average rules as the engine; no movement is ever refused here.
export function replayLedger(rows: readonly LedgerRow[]): LevelState {
  let level: LevelState = { onHand: 0, reserved: 0, valueCents: 0n }
  for (const row of rows) {
    const plan = planMovement(level, row.type, row.quantity, {
      allowNegativeStock: true,
      force: true,
      // The cost the movement recorded: the one it brought, or the average it left at (the engine recomputes the same)
      unitCostCents: bringsUnitsIn(row.type) ? row.unitCostCents : null
    })
    // With `force` a movement is never refused
    if (plan.ok) level = plan.next
  }
  return level
}
