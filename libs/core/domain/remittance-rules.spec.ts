import {
  ageInDays,
  classifyLine,
  expectedCodCents,
  guideKey,
  lineExpectedCents,
  type MatchShipment,
  remittanceTotals
} from './remittance-rules'
import { CodStatus, RemittanceLineOutcome, ShippingPayer } from './status-enums'

const shipment = (over: Partial<MatchShipment> = {}): MatchShipment => ({
  codStatus: CodStatus.PENDING_REMITTANCE,
  codAmountCents: 1000,
  codExpectedCents: 1000,
  carrierCostCents: null,
  shippingPayer: ShippingPayer.SENDER,
  ...over
})

describe('expectedCodCents (TDD_17 §4.15)', () => {
  const base = {
    codAmountCents: 1000,
    carrierCostCents: 300,
    shippingPayer: ShippingPayer.SENDER,
    deductsFee: true
  }
  it('deducts the fee only when the carrier deducts it, the sender pays and the cost is known', () => {
    expect(expectedCodCents(base)).toBe(700)
    expect(expectedCodCents({ ...base, deductsFee: false })).toBe(1000)
    expect(expectedCodCents({ ...base, shippingPayer: ShippingPayer.RECIPIENT })).toBe(1000)
    expect(expectedCodCents({ ...base, carrierCostCents: null })).toBe(1000)
  })
  it('never goes below zero', () => {
    expect(expectedCodCents({ ...base, carrierCostCents: 5000 })).toBe(0)
  })
})

describe('lineExpectedCents', () => {
  it('keeps the amount written at delivery', () => {
    expect(lineExpectedCents(shipment({ codExpectedCents: 800 }), null, true)).toBe(800)
  })
  it('falls back to the gross amount when none was written', () => {
    expect(lineExpectedCents(shipment({ codExpectedCents: null }), null, true)).toBe(1000)
  })
  it('reads the fee of the line when the cost was unknown, the carrier deducts and the sender pays', () => {
    expect(lineExpectedCents(shipment(), 120, true)).toBe(880)
    expect(lineExpectedCents(shipment(), 120, false)).toBe(1000)
    expect(lineExpectedCents(shipment({ shippingPayer: ShippingPayer.RECIPIENT }), 120, true)).toBe(
      1000
    )
    expect(
      lineExpectedCents(shipment({ carrierCostCents: 50, codExpectedCents: 950 }), 120, true)
    ).toBe(950)
    expect(lineExpectedCents(shipment(), 5000, true)).toBe(0)
    // The cost arrived after the delivery wrote the gross amount: it is worked out again with the cost
    expect(
      lineExpectedCents(shipment({ carrierCostCents: 300, codExpectedCents: 1000 }), null, true)
    ).toBe(700)
    expect(
      lineExpectedCents(shipment({ carrierCostCents: 300, codExpectedCents: 1000 }), null, false)
    ).toBe(1000)
  })
  it('has no amount for a prepaid shipment', () => {
    expect(lineExpectedCents(shipment({ codAmountCents: null }), null, true)).toBeNull()
  })
})

describe('classifyLine', () => {
  const line = { reportedCents: 1000, reportedFeeCents: null, duplicate: false }
  it('matches when the reported amount is the expected one', () => {
    expect(classifyLine({ ...line, shipment: shipment() }, false)).toEqual({
      outcome: RemittanceLineOutcome.MATCHED,
      expectedCents: 1000
    })
  })
  it('says the amount differs, also for a shipment already in discrepancy', () => {
    for (const codStatus of [CodStatus.PENDING_REMITTANCE, CodStatus.DISCREPANCY]) {
      expect(
        classifyLine({ ...line, reportedCents: 900, shipment: shipment({ codStatus }) }, false)
          .outcome
      ).toBe(RemittanceLineOutcome.AMOUNT_DIFFERS)
    }
  })
  it('keeps the other outcomes apart', () => {
    expect(classifyLine({ ...line, shipment: null }, false).outcome).toBe(
      RemittanceLineOutcome.NOT_FOUND
    )
    expect(classifyLine({ ...line, duplicate: true, shipment: shipment() }, false).outcome).toBe(
      RemittanceLineOutcome.DUPLICATE_IN_FILE
    )
    expect(
      classifyLine({ ...line, shipment: shipment({ codStatus: CodStatus.REMITTED }) }, false)
        .outcome
    ).toBe(RemittanceLineOutcome.ALREADY_REMITTED)
    for (const codStatus of [CodStatus.NOT_DELIVERED, CodStatus.NOT_APPLICABLE, CodStatus.VOID]) {
      expect(classifyLine({ ...line, shipment: shipment({ codStatus }) }, false)).toEqual({
        outcome: RemittanceLineOutcome.NOT_DELIVERED,
        expectedCents: null
      })
    }
  })
  it('holds a line against its own fee when the cost was unknown', () => {
    expect(
      classifyLine(
        { ...line, reportedCents: 880, reportedFeeCents: 120, shipment: shipment() },
        true
      )
    ).toEqual({ outcome: RemittanceLineOutcome.MATCHED, expectedCents: 880 })
  })
})

describe('remittanceTotals', () => {
  const entry = (over: Partial<Parameters<typeof remittanceTotals>[0][number]>) => ({
    outcome: RemittanceLineOutcome.MATCHED,
    excluded: false,
    reportedCents: 100,
    reportedFeeCents: null,
    expectedCents: 100,
    ...over
  })
  it('counts only the lines that settle a shipment', () => {
    expect(
      remittanceTotals([
        entry({}),
        entry({
          outcome: RemittanceLineOutcome.AMOUNT_DIFFERS,
          reportedCents: 80,
          reportedFeeCents: 5
        }),
        entry({ excluded: true }),
        entry({ outcome: RemittanceLineOutcome.NOT_FOUND, expectedCents: null }),
        entry({ outcome: RemittanceLineOutcome.DUPLICATE_IN_FILE }),
        entry({ outcome: RemittanceLineOutcome.ALREADY_REMITTED }),
        entry({ outcome: RemittanceLineOutcome.NOT_DELIVERED, expectedCents: null })
      ])
    ).toEqual({ expectedCents: 200, reportedCents: 180, feeCents: 5, differenceCents: -20 })
  })
  it('is zero with no lines', () => {
    expect(remittanceTotals([])).toEqual({
      expectedCents: 0,
      reportedCents: 0,
      feeCents: 0,
      differenceCents: 0
    })
  })
  it('counts an amount that is not known as zero expected', () => {
    expect(remittanceTotals([entry({ expectedCents: null })]).expectedCents).toBe(0)
  })
})

describe('guideKey and ageInDays', () => {
  it('ignores case and surrounding whitespace', () => {
    expect(guideKey('  Ab-12 ')).toBe('ab-12')
  })
  it('counts whole days and never a negative age', () => {
    const now = new Date('2026-11-12T12:00:00Z')
    expect(ageInDays(new Date('2026-11-09T13:00:00Z'), now)).toBe(2)
    expect(ageInDays(new Date('2026-11-13T00:00:00Z'), now)).toBe(0)
  })
})
