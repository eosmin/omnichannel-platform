import {
  InventoryManualMovements,
  InventoryMovementEffects,
  InventoryMovementsThatBringUnitsIn
} from './inventory-constants'
import { InventoryMovementType } from './status-enums'

describe('the movements of the ledger', () => {
  it('says what every type does to a level, none left out', () => {
    expect(Object.keys(InventoryMovementEffects).sort()).toEqual(
      Object.values(InventoryMovementType).sort()
    )
  })

  it('moves exactly one of the two counters per type, but an issue, which consumes its reservation', () => {
    for (const type of Object.values(InventoryMovementType)) {
      const effect = InventoryMovementEffects[type]
      const moved = (effect.onHand !== 0 ? 1 : 0) + (effect.reserved !== 0 ? 1 : 0)
      expect(moved).toBe(type === InventoryMovementType.ISSUE ? 2 : 1)
    }
    expect(InventoryMovementEffects[InventoryMovementType.ISSUE]).toEqual({
      onHand: -1,
      reserved: -1
    })
  })

  it('has the units-in types as exactly the ones that add to what is on hand', () => {
    const adding = Object.entries(InventoryMovementEffects)
      .filter(([, effect]) => effect.onHand === 1)
      .map(([type]) => type)
    expect([...InventoryMovementsThatBringUnitsIn].sort()).toEqual(adding.sort())
  })

  it('asks a reason only of the two manual adjustments', () => {
    expect([...InventoryManualMovements].sort()).toEqual([
      InventoryMovementType.ADJUSTMENT_IN,
      InventoryMovementType.ADJUSTMENT_OUT
    ])
  })
})
