import {
  marginGroups,
  marginWarningKeyOf,
  shortStoreId,
  vatBalanceKind,
  vatKindKeyOf,
  vatRowsOfMonth,
  vatSideKeyOf
} from './tax-view'

describe('the words of a VAT line', () => {
  it('knows the closed lists of the domain and shows an unknown code as it came', () => {
    expect(vatKindKeyOf('taxed')).toBe('taxed')
    expect(vatKindKeyOf('shipping_not_taxed')).toBe('shipping_not_taxed')
    expect(vatKindKeyOf('something_new')).toBeNull()
    // No member of Object.prototype answers for a code
    expect(vatKindKeyOf('constructor')).toBeNull()
    expect(vatSideKeyOf('output')).toBe('output')
    expect(vatSideKeyOf('toString')).toBeNull()
  })

  it('knows every warning of the margin', () => {
    for (const code of [
      'revenue_role_not_mapped',
      'cost_role_not_mapped',
      'orders_not_readable',
      'unvalued_units'
    ]) {
      expect(marginWarningKeyOf(code)).toBe(code)
    }
    expect(marginWarningKeyOf('new_warning')).toBeNull()
  })
})

describe('the balance of a month', () => {
  it('is to pay above zero, carried forward below and even at zero', () => {
    expect(vatBalanceKind(1)).toBe('toPay')
    expect(vatBalanceKind(-1)).toBe('carriedForward')
    expect(vatBalanceKind(0)).toBe('even')
  })
})

describe('the lines of a month', () => {
  it('splits the output and the input side and keeps the order of the api', () => {
    const rows = [
      { month: '2026-03', side: 'output', id: 1 },
      { month: '2026-04', side: 'output', id: 2 },
      { month: '2026-03', side: 'input', id: 3 },
      { month: '2026-03', side: 'output', id: 4 }
    ]
    const march = vatRowsOfMonth(rows, '2026-03')
    expect(march.output.map(row => row.id)).toEqual([1, 4])
    expect(march.input.map(row => row.id)).toEqual([3])
    expect(vatRowsOfMonth(rows, '2026-05')).toEqual({ output: [], input: [], other: [] })
    // A side the screen does not know is kept apart, not dropped
    const newer = vatRowsOfMonth([{ month: '2026-03', side: 'withheld', id: 9 }], '2026-03')
    expect(newer.other.map(row => row.id)).toEqual([9])
  })
})

describe('the margin by store', () => {
  it('groups by store in the order of the name and keeps the products in the order of the api', () => {
    const rows = [
      { storeId: 'b', productId: 'p1' },
      { storeId: 'a', productId: 'p2' },
      { storeId: 'b', productId: 'p3' }
    ]
    const names: Record<string, string> = { a: 'Zeta', b: 'Alfa' }
    const groups = marginGroups(rows, id => names[id] ?? id)
    expect(groups.map(group => group.name)).toEqual(['Alfa', 'Zeta'])
    expect(groups[0]?.rows.map(row => row.productId)).toEqual(['p1', 'p3'])
  })

  it('shortens the id of a store the person has no name for', () => {
    expect(shortStoreId('0b9a6c1e-1111-4222-8333-444455556666')).toBe('0b9a6c1e')
  })
})
