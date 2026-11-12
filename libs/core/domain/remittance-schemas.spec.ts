import { RemittanceLimits } from './remittance-rules'
import {
  addRemittanceLinesSchema,
  createRemittanceImportProfileSchema,
  remittanceImportPreviewSchema,
  confirmRemittanceSchema,
  createRemittanceSchema,
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
    const day = (receivedOn: string) =>
      createRemittanceSchema.safeParse({ connectionId: id, receivedOn }).success
    expect(day('2026-02-28')).toBe(true)
    expect(day('2026-02-31')).toBe(false)
    expect(day('12/11/2026')).toBe(false)
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

describe('the import profile schemas', () => {
  const columns = { guideNumber: 'Guia', amount: 'Monto' }
  it('refuses a delimiter that is also the decimal separator', () => {
    const base = { connectionId: id, name: 'x', columns }
    expect(
      createRemittanceImportProfileSchema.safeParse({
        ...base,
        delimiter: ',',
        decimalSeparator: ','
      }).success
    ).toBe(false)
    expect(
      createRemittanceImportProfileSchema.safeParse({
        ...base,
        delimiter: ';',
        decimalSeparator: ','
      }).success
    ).toBe(true)
    // The defaults are a comma and a dot
    expect(createRemittanceImportProfileSchema.safeParse(base).success).toBe(true)
  })
  it('refuses two values read from the same column', () => {
    const base = { connectionId: id, name: 'x' }
    for (const same of [
      { guideNumber: 'Total', amount: ' total ' },
      { guideNumber: 0, amount: 0 },
      { guideNumber: 'A', amount: 'B', fee: 'b' }
    ]) {
      expect(
        createRemittanceImportProfileSchema.safeParse({ ...base, columns: same }).success
      ).toBe(false)
    }
    expect(
      createRemittanceImportProfileSchema.safeParse({
        ...base,
        columns: { guideNumber: 0, amount: 1, fee: 'Fee' }
      }).success
    ).toBe(true)
  })
  it('measures the sample of a preview in bytes', () => {
    const profile = { columns }
    const fits = 'a'.repeat(32 * 1024)
    expect(remittanceImportPreviewSchema.safeParse({ text: fits, profile }).success).toBe(true)
    // 16,385 characters of two bytes each are 32 KB and 2 bytes
    expect(
      remittanceImportPreviewSchema.safeParse({ text: 'é'.repeat(16 * 1024 + 1), profile }).success
    ).toBe(false)
  })
})
