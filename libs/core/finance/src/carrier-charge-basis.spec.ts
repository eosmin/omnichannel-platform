import { chargeBasisOf, prepaidGuideCostOf } from './carrier-charge-basis'
import { chargeAmounts } from './carrier-entry-rules'

const row = (over: { unitCost?: number | null; consumed?: boolean; onAdvance?: boolean } = {}) => ({
  shippingPayer: 'sender',
  codAmountCents: 2515,
  carrierCostCents: 300,
  carrierRateCents: 250,
  commissionBps: 450,
  guideMovements:
    over.consumed === false
      ? []
      : [{ unitCostCents: over.unitCost ?? 273, onAdvance: over.onAdvance ?? true }]
})

describe('prepaidGuideCostOf (HC-101)', () => {
  it('is the cost the advance gave up for a guide made on the advance', () => {
    expect(prepaidGuideCostOf([{ unitCostCents: 273, onAdvance: true }])).toBe(273)
  })

  it('is zero for a guide of a gift: it took nothing from the advance', () => {
    expect(prepaidGuideCostOf([{ unitCostCents: 0, onAdvance: true }])).toBe(0)
  })

  it('is null when the guide consumed nothing or had no average cost: no advance covered it', () => {
    expect(prepaidGuideCostOf([])).toBeNull()
    expect(prepaidGuideCostOf([{ unitCostCents: null, onAdvance: true }])).toBeNull()
  })

  it('is null for a guide made while the connection did not prepay, whatever it costs now', () => {
    expect(prepaidGuideCostOf([{ unitCostCents: 273, onAdvance: false }])).toBeNull()
  })
})

describe('chargeBasisOf', () => {
  it('carries the guide figures and the advance to the charge', () => {
    expect(chargeAmounts(chargeBasisOf(row()))).toEqual({
      freightCents: 273,
      advanceCents: 273,
      commissionCents: 113
    })
  })

  it('charges a guide made off the advance by what the carrier reported', () => {
    expect(chargeAmounts(chargeBasisOf(row({ onAdvance: false })))).toEqual({
      freightCents: 300,
      commissionCents: 113
    })
  })

  it('charges a prepaid guide that consumed nothing by what the carrier reported', () => {
    expect(chargeAmounts(chargeBasisOf(row({ consumed: false })))).toEqual({
      freightCents: 300,
      commissionCents: 113
    })
  })
})
