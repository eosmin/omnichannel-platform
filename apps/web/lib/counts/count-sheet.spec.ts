import type { CountLineView } from '@platform/api-client'

import {
  countedOf,
  exactSkuMatches,
  linesWithVariance,
  matchesSearch,
  progressOf,
  sortLines,
  varianceOfLine,
  varianceSummary,
  visibleLines
} from './count-sheet'

const line = (
  id: string,
  productName: string,
  expected: number,
  counted: number | null,
  extra: Partial<CountLineView> = {}
): CountLineView => ({
  id,
  storeId: 's1',
  productId: `p-${id}`,
  productName,
  sku: null,
  variantId: null,
  variantName: null,
  expectedQuantity: expected,
  countedQuantity: counted,
  variance: counted === null ? null : counted - expected,
  ...extra
})

const sheet = [
  line('c', 'Cap', 5, null, { sku: 'CAP-1' }),
  line('a', 'Shoe', 10, 8, { sku: 'SH-1', variantName: 'Red' }),
  line('b', 'Shoe', 4, 4, { sku: 'SH-2', variantName: 'Blue' }),
  line('d', 'Belt', 3, 9, { sku: null })
]

describe('what a line holds on the sheet', () => {
  it('takes what was typed over what the api has, and null as "not counted"', () => {
    const [cap, shoe] = [sheet[0] as CountLineView, sheet[1] as CountLineView]
    expect(countedOf(cap, {})).toBeNull()
    expect(countedOf(cap, { c: 6 })).toBe(6)
    expect(countedOf(shoe, {})).toBe(8)
    expect(countedOf(shoe, { a: 0 })).toBe(0)
    expect(countedOf(shoe, { a: null })).toBeNull()
  })

  it('measures the variance against the snapshot, never against a quantity read later', () => {
    const shoe = sheet[1] as CountLineView
    expect(varianceOfLine(shoe, {})).toBe(-2)
    expect(varianceOfLine(shoe, { a: 12 })).toBe(2)
    expect(varianceOfLine(shoe, { a: null })).toBeNull()
  })

  it('counts the progress with the quantities not saved yet', () => {
    expect(progressOf(sheet, {})).toEqual({ total: 4, counted: 3 })
    expect(progressOf(sheet, { c: 1, a: null })).toEqual({ total: 4, counted: 3 })
  })
})

describe('the list of the screen', () => {
  it('orders by product, then variant, then id', () => {
    expect(sortLines(sheet).map(item => item.id)).toEqual(['d', 'c', 'b', 'a'])
  })

  it('does not change the list it was given', () => {
    const before = sheet.map(item => item.id)
    sortLines(sheet)
    expect(sheet.map(item => item.id)).toEqual(before)
  })

  it('searches the product, the variant and the sku without case', () => {
    expect(matchesSearch(sheet[1] as CountLineView, 'SHO')).toBe(true)
    expect(matchesSearch(sheet[1] as CountLineView, 'red')).toBe(true)
    expect(matchesSearch(sheet[1] as CountLineView, 'sh-1')).toBe(true)
    expect(matchesSearch(sheet[1] as CountLineView, 'cap')).toBe(false)
    expect(matchesSearch(sheet[3] as CountLineView, 'zzz')).toBe(false)
    expect(matchesSearch(sheet[3] as CountLineView, '  ')).toBe(true)
  })

  it('finds the line of a scanned code only when the sku is exactly that', () => {
    expect(exactSkuMatches(sheet, ' sh-1 ').map(item => item.id)).toEqual(['a'])
    expect(exactSkuMatches(sheet, 'SH')).toEqual([])
    expect(exactSkuMatches(sheet, '')).toEqual([])
  })

  it('filters by counted state with the typed quantities, and by search', () => {
    expect(visibleLines(sheet, {}, 'uncounted', '').map(item => item.id)).toEqual(['c'])
    expect(visibleLines(sheet, { c: 2 }, 'uncounted', '')).toEqual([])
    expect(visibleLines(sheet, { a: null }, 'counted', '').map(item => item.id)).toEqual(['d', 'b'])
    expect(visibleLines(sheet, {}, 'all', 'shoe').map(item => item.id)).toEqual(['b', 'a'])
  })
})

describe('the review', () => {
  it('summarizes what the shelves hold more and less than the snapshot, and what was not counted', () => {
    expect(varianceSummary(sheet)).toEqual({
      withVariance: 2,
      unitsIn: 6,
      unitsOut: 2,
      uncounted: 1
    })
  })

  it('lists the lines with a variance, the biggest first, and none for a line without one', () => {
    expect(linesWithVariance(sheet).map(item => item.id)).toEqual(['d', 'a'])
  })
})
