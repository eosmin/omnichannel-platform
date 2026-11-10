import { InventoryMovementType as Type } from '@platform/core/domain'

import { planMovement, replayLedger, roundedDivision } from './movement-math'

const level = (onHand: number, reserved = 0, valueCents = 0n) => ({ onHand, reserved, valueCents })
const plan = (
  state: ReturnType<typeof level>,
  type: Type,
  quantity: number,
  options: { allowNegativeStock?: boolean; unitCostCents?: number | null } = {}
) =>
  planMovement(state, type, quantity, {
    allowNegativeStock: options.allowNegativeStock ?? false,
    unitCostCents: options.unitCostCents ?? null
  })
const applied = (result: ReturnType<typeof plan>) => {
  if (!result.ok) throw new Error(`refused: ${result.refusal.kind}`)
  return result
}

describe('roundedDivision', () => {
  it('rounds half up', () => {
    expect(roundedDivision(7n, 2n)).toBe(4n)
    expect(roundedDivision(5n, 3n)).toBe(2n)
    expect(roundedDivision(4n, 3n)).toBe(1n)
    expect(roundedDivision(0n, 5n)).toBe(0n)
  })
})

describe('what a movement does to a level', () => {
  it.each([
    [Type.RECEIPT, level(5, 2), level(8, 2)],
    [Type.ADJUSTMENT_IN, level(5, 2), level(8, 2)],
    [Type.TRANSFER_IN, level(5, 2), level(8, 2)],
    [Type.COUNT_IN, level(5, 2), level(8, 2)],
    [Type.RETURN_IN, level(5, 2), level(8, 2)],
    [Type.RESERVE, level(5, 1), level(5, 4)],
    [Type.RELEASE, level(5, 4), level(5, 1)],
    [Type.ISSUE, level(5, 4), level(2, 1)],
    [Type.ADJUSTMENT_OUT, level(5, 1), level(2, 1)],
    [Type.COUNT_OUT, level(5, 1), level(2, 1)],
    [Type.TRANSFER_OUT, level(5, 1), level(2, 1)]
  ])('%s moves the counters as the table says', (type, before, after) => {
    const result = applied(plan(before, type, 3))
    expect({ onHand: result.next.onHand, reserved: result.next.reserved }).toEqual({
      onHand: after.onHand,
      reserved: after.reserved
    })
  })
})

describe('the refusals', () => {
  it('refuses to reserve more than is available, and says how much is', () => {
    const result = plan(level(5, 3), Type.RESERVE, 3)
    expect(result).toEqual({ ok: false, refusal: { kind: 'insufficient_available', available: 2 } })
    expect(plan(level(5, 3), Type.RESERVE, 2).ok).toBe(true)
  })

  it('reserves beyond the stock when the store allows negative stock', () => {
    const result = applied(plan(level(1, 1), Type.RESERVE, 4, { allowNegativeStock: true }))
    expect(result.next).toMatchObject({ onHand: 1, reserved: 5 })
  })

  it('refuses an issue, an adjustment and a count that would leave less than nothing on hand', () => {
    for (const type of [Type.ISSUE, Type.ADJUSTMENT_OUT, Type.COUNT_OUT]) {
      const result = plan(level(2, 4), type, 3)
      expect(result.ok).toBe(false)
    }
    expect(plan(level(2, 0), Type.ADJUSTMENT_OUT, 3)).toEqual({
      ok: false,
      refusal: { kind: 'insufficient_on_hand', onHand: 2 }
    })
    expect(plan(level(3, 0), Type.ADJUSTMENT_OUT, 3).ok).toBe(true)
  })

  it('lets them go below zero when the store allows it', () => {
    for (const type of [Type.ADJUSTMENT_OUT, Type.COUNT_OUT]) {
      const result = applied(plan(level(2, 0), type, 5, { allowNegativeStock: true }))
      expect(result.next.onHand).toBe(-3)
    }
    // An issue still consumes a reservation that exists
    expect(
      applied(plan(level(1, 3), Type.ISSUE, 3, { allowNegativeStock: true })).next
    ).toMatchObject({
      onHand: -2,
      reserved: 0
    })
  })

  it('never takes a transfer out of reserved stock, whatever the setting says', () => {
    for (const allowNegativeStock of [false, true]) {
      const result = plan(level(5, 4), Type.TRANSFER_OUT, 2, { allowNegativeStock })
      expect(result).toEqual({
        ok: false,
        refusal: { kind: 'insufficient_available', available: 1 }
      })
    }
    expect(plan(level(5, 4), Type.TRANSFER_OUT, 1, { allowNegativeStock: true }).ok).toBe(true)
  })

  it('refuses to release or issue what is not reserved', () => {
    for (const type of [Type.RELEASE, Type.ISSUE]) {
      expect(plan(level(10, 2), type, 3)).toEqual({
        ok: false,
        refusal: { kind: 'reservation_exceeded', reserved: 2 }
      })
    }
  })

  it('refuses a movement that would lower a level that is already negative, while negative stock is off', () => {
    expect(plan(level(-2, 0), Type.ADJUSTMENT_OUT, 1).ok).toBe(false)
    expect(plan(level(-2, 0), Type.RESERVE, 1).ok).toBe(false)
    // A receipt brings it back
    expect(applied(plan(level(-2, 0), Type.RECEIPT, 5)).next.onHand).toBe(3)
  })
})

describe('weighted-average cost', () => {
  it('adds the value of what comes in at the cost it brings', () => {
    const first = applied(plan(level(0), Type.RECEIPT, 10, { unitCostCents: 200 }))
    expect(first.next.valueCents).toBe(2000n)
    expect(first.unitCostCents).toBe(200)
    // 10 at 2.00 and 10 at 3.00: the average is 2.50
    const second = applied(plan(level(10, 0, 2000n), Type.RECEIPT, 10, { unitCostCents: 300 }))
    expect(second.next.valueCents).toBe(5000n)
  })

  it('takes units out at the average cost of the level and records it', () => {
    const out = applied(plan(level(20, 0, 5000n), Type.ADJUSTMENT_OUT, 4))
    expect(out.unitCostCents).toBe(250)
    expect(out.next).toMatchObject({ onHand: 16, valueCents: 4000n })
  })

  it('records no cost for a reserve or a release and leaves the value alone', () => {
    for (const [type, state] of [
      [Type.RESERVE, level(10, 0, 1000n)],
      [Type.RELEASE, level(10, 3, 1000n)]
    ] as const) {
      const result = applied(plan(state, type, 2))
      expect(result.unitCostCents).toBeNull()
      expect(result.next.valueCents).toBe(1000n)
    }
  })

  it('empties the value with the last unit, so that rounding leaves no residue', () => {
    // 3 units worth 10 cents: 3.33 each
    const first = applied(plan(level(3, 0, 10n), Type.ADJUSTMENT_OUT, 1))
    expect(first.next.valueCents).toBe(7n)
    const second = applied(plan(first.next, Type.ADJUSTMENT_OUT, 1))
    expect(second.next.valueCents).toBe(3n)
    const last = applied(plan(second.next, Type.ADJUSTMENT_OUT, 1))
    expect(last.next).toMatchObject({ onHand: 0, valueCents: 0n })
  })

  it('prices units that come in with no cost at the current average, and at zero when there is none', () => {
    const atAverage = applied(plan(level(10, 0, 3000n), Type.RECEIPT, 10))
    expect(atAverage.next.valueCents).toBe(6000n)
    expect(atAverage.unitCostCents).toBeNull()
    const none = applied(plan(level(0), Type.RECEIPT, 10))
    expect(none.next.valueCents).toBe(0n)
  })

  it('values only the units above zero when a deficit is covered', () => {
    // 2 short, 5 arrive at 2.00: 3 units on hand worth 6.00
    const covered = applied(plan(level(-2), Type.RECEIPT, 5, { unitCostCents: 200 }))
    expect(covered.next).toMatchObject({ onHand: 3, valueCents: 600n })
    // Still short after the receipt: nothing to value
    const short = applied(plan(level(-5), Type.RECEIPT, 2, { unitCostCents: 200 }))
    expect(short.next).toMatchObject({ onHand: -3, valueCents: 0n })
  })

  it('takes nothing out of the value, and records no cost, for units that were never on hand', () => {
    const out = applied(plan(level(0), Type.ADJUSTMENT_OUT, 3, { allowNegativeStock: true }))
    expect(out.unitCostCents).toBeNull()
    expect(out.next).toMatchObject({ onHand: -3, valueCents: 0n })
    // Only what was on hand carries value: 2 of the 5 units that leave
    const partial = applied(
      plan(level(2, 0, 500n), Type.ADJUSTMENT_OUT, 5, { allowNegativeStock: true })
    )
    expect(partial.next).toMatchObject({ onHand: -3, valueCents: 0n })
    expect(partial.unitCostCents).toBe(250)
  })

  it('works in numbers a 32-bit integer cannot hold', () => {
    const big = applied(plan(level(0), Type.RECEIPT, 1_000_000, { unitCostCents: 100_000_000 }))
    expect(big.next.valueCents).toBe(100_000_000_000_000n)
    const out = applied(plan(big.next, Type.ADJUSTMENT_OUT, 1))
    expect(out.unitCostCents).toBe(100_000_000)
  })
})

describe('replayLedger', () => {
  const row = (type: Type, quantity: number, unitCostCents: number | null = null) => ({
    type,
    quantity,
    unitCostCents
  })

  it('is an empty level for an empty ledger', () => {
    expect(replayLedger([])).toEqual({ onHand: 0, reserved: 0, valueCents: 0n })
  })

  it('rebuilds the level the engine kept: counters and value, in the order of the ledger', () => {
    const rows = [
      row(Type.RECEIPT, 10, 200),
      row(Type.RECEIPT, 10, 300),
      row(Type.RESERVE, 5),
      row(Type.ISSUE, 3),
      row(Type.RELEASE, 2),
      row(Type.ADJUSTMENT_OUT, 4, 250),
      row(Type.RETURN_IN, 1, 250)
    ]
    // The same steps through the engine
    let level = level0()
    for (const next of rows)
      level = applied(
        plan(level, next.type, next.quantity, { unitCostCents: next.unitCostCents })
      ).next
    expect(replayLedger(rows)).toEqual(level)
  })

  it('applies as written what the rules would refuse now: the ledger is what happened', () => {
    // A level that went negative while the store allowed it
    const rows = [row(Type.RECEIPT, 2, 100), row(Type.ADJUSTMENT_OUT, 5, null)]
    expect(replayLedger(rows)).toMatchObject({ onHand: -3, reserved: 0, valueCents: 0n })
    // What the rules would refuse (a transfer out of reserved stock) is applied as written, value included
    expect(
      replayLedger([row(Type.RECEIPT, 4, 100), row(Type.RESERVE, 4), row(Type.TRANSFER_OUT, 2)])
    ).toMatchObject({ onHand: 2, reserved: 4, valueCents: 200n })
  })
})

function level0() {
  return level(0)
}
