import { RemittanceLimits } from './remittance-rules'
import {
  addRemittanceLinesSchema,
  confirmRemittanceSchema,
  createRemittanceSchema,
  remittanceDaySchema,
  remittancePendingQuerySchema,
  updateRemittanceLineSchema,
  voidRemittanceSchema
} from './remittance-schemas'

const id = '0d3f6f0e-6f3b-4a8c-9a25-0d1c1d2c3b4a'

describe('remittance schemas', () => {
  it('takes a draft with or without lines and refuses a store, a status or a total', () => {
    expect(createRemittanceSchema.parse({ connectionId: id }).lines).toEqual([])
    expect(
      createRemittanceSchema.parse({
        connectionId: id,
        reference: ' LIQ-1 ',
        receivedOn: '2026-11-12',
        lines: [{ guideNumber: ' G1 ', reportedCents: 100, reportedFeeCents: 5 }]
      }).lines[0]
    ).toMatchObject({ guideNumber: 'G1', reportedCents: 100, reportedFeeCents: 5 })
    for (const extra of [{ storeId: id }, { status: 'confirmed' }, { expectedCents: 1 }]) {
      expect(createRemittanceSchema.safeParse({ connectionId: id, ...extra }).success).toBe(false)
    }
    expect(createRemittanceSchema.safeParse({}).success).toBe(false)
  })
  it('refuses an amount that is not whole, negative, too large or not a number', () => {
    for (const reportedCents of [
      10.5,
      -1,
      RemittanceLimits.MAX_AMOUNT_CENTS + 1,
      '10',
      Number.NaN
    ]) {
      expect(
        addRemittanceLinesSchema.safeParse({ lines: [{ guideNumber: 'G', reportedCents }] }).success
      ).toBe(false)
    }
    expect(addRemittanceLinesSchema.safeParse({ lines: [] }).success).toBe(false)
    expect(
      addRemittanceLinesSchema.safeParse({ lines: [{ guideNumber: '  ', reportedCents: 1 }] })
        .success
    ).toBe(false)
  })
  it('refuses more lines than a settlement file holds', () => {
    const lines = Array.from({ length: RemittanceLimits.MAX_LINES + 1 }, (_, index) => ({
      guideNumber: `G${index}`,
      reportedCents: 1
    }))
    expect(addRemittanceLinesSchema.safeParse({ lines }).success).toBe(false)
  })
  it('takes a day that exists', () => {
    expect(remittanceDaySchema.safeParse('2026-02-28').success).toBe(true)
    expect(remittanceDaySchema.safeParse('2026-02-31').success).toBe(false)
    expect(remittanceDaySchema.safeParse('12/11/2026').success).toBe(false)
  })
  it('needs one change in a line and takes null to clear a note or a fee', () => {
    expect(updateRemittanceLineSchema.safeParse({}).success).toBe(false)
    expect(
      updateRemittanceLineSchema.safeParse({ note: null, reportedFeeCents: null }).success
    ).toBe(true)
    expect(updateRemittanceLineSchema.safeParse({ outcome: 'matched' }).success).toBe(false)
    expect(updateRemittanceLineSchema.safeParse({ note: 'a\u0000b' }).success).toBe(false)
  })
  it('takes an empty confirmation, an optional void reason and an optional connection filter', () => {
    expect(confirmRemittanceSchema.safeParse({}).success).toBe(true)
    expect(confirmRemittanceSchema.safeParse({ status: 'voided' }).success).toBe(false)
    expect(voidRemittanceSchema.safeParse({}).success).toBe(true)
    expect(remittancePendingQuerySchema.safeParse({ connectionId: 'nope' }).success).toBe(false)
    expect(remittancePendingQuerySchema.safeParse({ connectionId: id }).success).toBe(true)
  })
})
