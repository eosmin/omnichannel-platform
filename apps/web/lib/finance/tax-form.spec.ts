import type { FinanceTaxRateView } from '@platform/api-client'

import {
  createTaxRateInputOf,
  emptyTaxRateDraft,
  taxRateDraftOf,
  taxRateProblem,
  updateTaxRateInputOf
} from './tax-form'

const rate: FinanceTaxRateView = {
  id: 't1',
  code: 'IVA13',
  name: 'IVA 13 %',
  rateBps: 1300,
  kind: 'vat',
  outputAccountId: 'out',
  inputAccountId: 'in',
  active: true,
  isDefault: false,
  createdAt: '2026-11-15T10:00:00.000Z',
  updatedAt: '2026-11-15T10:00:00.000Z'
}

const valid = {
  ...emptyTaxRateDraft(),
  code: 'IVA13',
  name: 'IVA',
  percent: '13',
  outputAccountId: 'out',
  inputAccountId: 'in'
}

describe('taxRateProblem', () => {
  it('accepts a complete draft', () => {
    expect(taxRateProblem(valid)).toBeNull()
  })

  it('names the first thing that is wrong', () => {
    expect(taxRateProblem({ ...valid, code: '' })).toBe('code')
    expect(taxRateProblem({ ...valid, name: ' ' })).toBe('name')
    expect(taxRateProblem({ ...valid, percent: '' })).toBe('percent')
    expect(taxRateProblem({ ...valid, outputAccountId: '' })).toBe('outputAccount')
    expect(taxRateProblem({ ...valid, inputAccountId: '' })).toBe('inputAccount')
  })

  it.each(['abc', '-1', '1.234', '100.01', '101', '1e1'])('refuses the rate %j', percent => {
    expect(taxRateProblem({ ...valid, percent })).toBe('percent')
  })

  it('accepts the ends: no tax and the whole amount', () => {
    expect(taxRateProblem({ ...valid, percent: '0' })).toBeNull()
    expect(taxRateProblem({ ...valid, percent: '100' })).toBeNull()
  })
})

describe('the input of a tax rate', () => {
  it('sends the percent as basis points, whole', () => {
    expect(createTaxRateInputOf({ ...valid, percent: '12.5', code: ' IVA ' })).toEqual({
      code: 'IVA',
      name: 'IVA',
      rateBps: 1250,
      outputAccountId: 'out',
      inputAccountId: 'in',
      isDefault: false
    })
  })

  it('sends only what changed', () => {
    expect(updateTaxRateInputOf(rate, { ...taxRateDraftOf(rate), percent: '15' })).toEqual({
      rateBps: 1500
    })
    expect(updateTaxRateInputOf(rate, taxRateDraftOf(rate))).toEqual({})
  })

  it('refuses to turn an unchecked percent into a rate of 0', () => {
    expect(() => createTaxRateInputOf({ ...valid, percent: 'abc' })).toThrow()
    expect(() =>
      updateTaxRateInputOf(rate, { ...taxRateDraftOf(rate), percent: '13.555' })
    ).toThrow()
  })

  it('can make a rate the default and never takes the default away by itself', () => {
    expect(updateTaxRateInputOf(rate, { ...taxRateDraftOf(rate), isDefault: true })).toEqual({
      isDefault: true
    })
    const current = { ...rate, isDefault: true }
    expect(updateTaxRateInputOf(current, { ...taxRateDraftOf(current), isDefault: false })).toEqual(
      {}
    )
  })
})
