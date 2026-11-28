import {
  createExcludedSubjectPurchaseSchema,
  ExcludedSubjectLimits,
  ExcludedSubjectLineKinds,
  withheldIncomeTaxOf
} from './excluded-subject-purchases'

const goods = (amountCents: number) => ({ kind: ExcludedSubjectLineKinds.GOODS, amountCents })
const service = (amountCents: number) => ({ kind: ExcludedSubjectLineKinds.SERVICE, amountCents })

describe('withheldIncomeTaxOf (articles 154 and 156 of the Tax Code)', () => {
  it('withholds nothing on goods', () => {
    expect(withheldIncomeTaxOf([goods(100_000)])).toBe(0)
  })

  it('withholds ten per cent of a service', () => {
    expect(withheldIncomeTaxOf([service(100_000)])).toBe(10_000)
  })

  it('withholds on the services of a mixed purchase and not on its goods', () => {
    expect(withheldIncomeTaxOf([goods(50_000), service(20_000), goods(1), service(5_000)])).toBe(
      2_500
    )
  })

  it('rounds the whole sum of the services to the cent, half up, not concept by concept', () => {
    // 10 % of 1.05 is 0.105: half a cent goes up
    expect(withheldIncomeTaxOf([service(105)])).toBe(11)
    expect(withheldIncomeTaxOf([service(104)])).toBe(10)
    // Concept by concept each of these would give 0 (10 % of 4 cents is 0.4); on the sum of the services it is 1
    expect(withheldIncomeTaxOf([service(4), service(4), service(4)])).toBe(1)
  })

  it('is exact where a float is not', () => {
    // 0.1 * 3 style traps: the figure is whole numbers all the way
    expect(withheldIncomeTaxOf([service(999_999_999)])).toBe(100_000_000)
    expect(withheldIncomeTaxOf([service(1_005)])).toBe(101)
  })

  it('is zero for no concept at all', () => {
    expect(withheldIncomeTaxOf([])).toBe(0)
  })
})

describe('createExcludedSubjectPurchaseSchema', () => {
  const valid = {
    idempotencyKey: 'excluded-key-0001',
    purchasedOn: '2026-11-10',
    seller: { documentType: '2', documentNumber: '012345678', name: 'Persona Vendedora' },
    operationType: '1',
    expenseClass: '2',
    sector: '2',
    costType: '1',
    lines: [{ description: 'flete', kind: 'service', amountCents: 5000 }]
  }

  it('takes a purchase with the VAT withheld at zero by default', () => {
    const parsed = createExcludedSubjectPurchaseSchema.parse(valid)
    expect(parsed.vatWithheldCents).toBe(0)
  })

  it('refuses a figure for the income tax: it is computed, never stated', () => {
    expect(
      createExcludedSubjectPurchaseSchema.safeParse({ ...valid, incomeTaxWithheldCents: 0 }).success
    ).toBe(false)
  })

  it('refuses a kind that is not goods or service', () => {
    const lines = [{ description: 'x', kind: 'rent', amountCents: 100 }]
    expect(createExcludedSubjectPurchaseSchema.safeParse({ ...valid, lines }).success).toBe(false)
  })

  it('takes the series and the code of generation together or none', () => {
    const one = { ...valid, documentSeries: 'ABCDEF' }
    expect(createExcludedSubjectPurchaseSchema.safeParse(one).success).toBe(false)
    const both = { ...one, generationCode: 'A1B2C3D4-0000-4000-8000-000000000001' }
    expect(createExcludedSubjectPurchaseSchema.safeParse(both).success).toBe(true)
  })

  it('refuses a purchase the annex could not declare', () => {
    const lines = [
      { description: 'a', kind: 'goods', amountCents: ExcludedSubjectLimits.MAX_TOTAL_CENTS },
      { description: 'b', kind: 'goods', amountCents: 1 }
    ]
    expect(createExcludedSubjectPurchaseSchema.safeParse({ ...valid, lines }).success).toBe(false)
  })

  it('refuses a VAT withheld above what was paid and a day that is not a day', () => {
    expect(
      createExcludedSubjectPurchaseSchema.safeParse({ ...valid, vatWithheldCents: 5001 }).success
    ).toBe(false)
    expect(
      createExcludedSubjectPurchaseSchema.safeParse({ ...valid, purchasedOn: '2026-02-30' }).success
    ).toBe(false)
  })

  it('refuses a day before the first year of the annexes', () => {
    expect(
      createExcludedSubjectPurchaseSchema.safeParse({ ...valid, purchasedOn: '1926-11-10' }).success
    ).toBe(false)
  })

  it('refuses no concepts', () => {
    expect(createExcludedSubjectPurchaseSchema.safeParse({ ...valid, lines: [] }).success).toBe(
      false
    )
  })
})
