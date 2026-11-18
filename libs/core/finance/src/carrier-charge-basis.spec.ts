import { CarrierChargeModel } from '@platform/core/domain'

import { chargeBasisOf, prepaidGuideCostOf } from './carrier-charge-basis'
import { chargeAmounts } from './carrier-entry-rules'

const SINCE = new Date('2027-01-10T00:00:00Z')
const AFTER = new Date('2027-01-11T00:00:00Z')
const BEFORE = new Date('2027-01-09T00:00:00Z')
const connection = (chargeModel: string) => ({ chargeModel, chargeModelSince: SINCE })

const row = (
  over: { chargeModel?: string; unitCost?: number | null; consumed?: boolean; madeAt?: Date } = {}
) => ({
  shippingPayer: 'sender',
  codAmountCents: 2515,
  carrierCostCents: 300,
  carrierRateCents: 250,
  commissionBps: 450,
  connection: {
    chargeModel: over.chargeModel ?? CarrierChargeModel.PREPAID,
    chargeModelSince: SINCE
  },
  guideMovements:
    over.consumed === false
      ? []
      : [{ unitCostCents: over.unitCost ?? 273, occurredAt: over.madeAt ?? AFTER }]
})

describe('prepaidGuideCostOf (HC-101)', () => {
  const taken = (unitCostCents: number | null, occurredAt = AFTER) => [
    { unitCostCents, occurredAt }
  ]

  it('is the cost the advance gave up for a guide of a prepaid connection', () => {
    expect(prepaidGuideCostOf(connection(CarrierChargeModel.PREPAID), taken(273))).toBe(273)
  })

  it('is zero for a guide of a gift: it took nothing from the advance', () => {
    expect(prepaidGuideCostOf(connection(CarrierChargeModel.PREPAID), taken(0))).toBe(0)
  })

  it('is null when the guide consumed nothing or had no average cost: no advance covered it', () => {
    expect(prepaidGuideCostOf(connection(CarrierChargeModel.PREPAID), [])).toBeNull()
    expect(prepaidGuideCostOf(connection(CarrierChargeModel.PREPAID), taken(null))).toBeNull()
  })

  it('is null for a guide made before the connection began to prepay: it is in the opening balance', () => {
    expect(
      prepaidGuideCostOf(connection(CarrierChargeModel.PREPAID), taken(273, BEFORE))
    ).toBeNull()
    expect(prepaidGuideCostOf(connection(CarrierChargeModel.PREPAID), taken(273, SINCE))).toBe(273)
  })

  it('is null for a connection that does not prepay, whatever its guides consumed', () => {
    expect(prepaidGuideCostOf(connection(CarrierChargeModel.INVOICED), taken(273))).toBeNull()
    expect(prepaidGuideCostOf(connection(CarrierChargeModel.REMITTANCE), taken(273))).toBeNull()
    expect(prepaidGuideCostOf(connection('something-new'), taken(273))).toBeNull()
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

  it('charges a guide of an invoiced connection by what the carrier reported', () => {
    expect(chargeAmounts(chargeBasisOf(row({ chargeModel: CarrierChargeModel.INVOICED })))).toEqual(
      { freightCents: 300, commissionCents: 113 }
    )
  })

  it('charges a prepaid guide made before the switch by what the carrier reported', () => {
    expect(chargeAmounts(chargeBasisOf(row({ madeAt: BEFORE })))).toEqual({
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
