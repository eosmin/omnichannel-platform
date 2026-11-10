import { InventoryAdjustmentReason } from '@platform/core/domain'

import {
  adjustmentFrom,
  emptyStockForm,
  parseUnits,
  signedQuantity,
  StockActions,
  type StockFormValues
} from './stock-form'

const plain = { id: 'p1', variants: [] }
const withVariants = {
  id: 'p1',
  variants: [{ active: true }, { active: false }] as never
}
const form = (change: Partial<StockFormValues> = {}): StockFormValues => ({
  ...emptyStockForm('w1'),
  quantity: '5',
  ...change
})

describe('parseUnits', () => {
  it.each([
    ['5', 5],
    [' 12 ', 12],
    ['1000000', 1_000_000]
  ])('reads %p as %p', (text, units) => {
    expect(parseUnits(text)).toBe(units)
  })

  it.each([[''], ['0'], ['-3'], ['1.5'], ['1,5'], ['1e3'], ['1000001'], ['١٢'], ['12 3']])(
    'refuses %p',
    text => {
      expect(parseUnits(text)).toBeNull()
    }
  )
})

describe('adjustmentFrom', () => {
  it('builds a receipt with its reason, leaving out what was not written', () => {
    expect(adjustmentFrom(form(), plain, false)).toEqual({
      ok: true,
      value: {
        warehouseId: 'w1',
        productId: 'p1',
        type: 'receipt',
        quantity: 5,
        reason: InventoryAdjustmentReason.OPENING_STOCK
      }
    })
  })

  it('maps each action to the type of the api', () => {
    const typeOf = (action: StockFormValues['action']): string | undefined => {
      const result = adjustmentFrom(
        form({ action, reason: InventoryAdjustmentReason.OTHER }),
        plain,
        false
      )
      return result.ok ? result.value.type : undefined
    }
    expect(typeOf(StockActions.RECEIVE)).toBe('receipt')
    expect(typeOf(StockActions.ADD)).toBe('adjustment_in')
    expect(typeOf(StockActions.REMOVE)).toBe('adjustment_out')
  })

  it('needs a warehouse and whole units', () => {
    expect(adjustmentFrom(form({ warehouseId: '' }), plain, false)).toEqual({
      ok: false,
      field: 'warehouse'
    })
    for (const quantity of ['', '0', '2.5', '-1']) {
      expect(adjustmentFrom(form({ quantity }), plain, false)).toEqual({
        ok: false,
        field: 'quantity'
      })
    }
  })

  it('asks for a variant of a product that has active ones, but lets what is on the bare row leave', () => {
    expect(adjustmentFrom(form(), withVariants, false)).toEqual({ ok: false, field: 'variant' })
    const named = adjustmentFrom(form({ variantId: 'v1' }), withVariants, false)
    expect(named).toMatchObject({ ok: true, value: { variantId: 'v1' } })
    const out = adjustmentFrom(
      form({ action: StockActions.REMOVE, reason: InventoryAdjustmentReason.LOST }),
      withVariants,
      false
    )
    expect(out.ok).toBe(true)
  })

  it('keeps a note, trimmed, and refuses one with a line break or too long', () => {
    const noted = adjustmentFrom(form({ note: '  delivery  ' }), plain, false)
    expect(noted).toMatchObject({ ok: true, value: { note: 'delivery' } })
    expect(adjustmentFrom(form({ note: 'a\nb' }), plain, false)).toEqual({
      ok: false,
      field: 'note'
    })
    expect(adjustmentFrom(form({ note: 'x'.repeat(501) }), plain, false)).toEqual({
      ok: false,
      field: 'note'
    })
  })

  it('sends the cost of a unit in cents only when it may be set and units come in', () => {
    const costed = form({ unitCost: '3.40' })
    expect(adjustmentFrom(costed, plain, true)).toMatchObject({
      ok: true,
      value: { unitCostCents: 340 }
    })
    // Without the permission the field is not even read, so a cost never travels
    const without = adjustmentFrom(costed, plain, false)
    expect(without.ok && 'unitCostCents' in without.value).toBe(false)
    const leaving = adjustmentFrom(
      form({
        action: StockActions.REMOVE,
        reason: InventoryAdjustmentReason.LOST,
        unitCost: '3.40'
      }),
      plain,
      true
    )
    expect(leaving.ok && 'unitCostCents' in leaving.value).toBe(false)
    expect(adjustmentFrom(form({ unitCost: '3.999' }), plain, true)).toEqual({
      ok: false,
      field: 'unitCost'
    })
  })
})

describe('signedQuantity', () => {
  it('counts what comes in as positive, what goes out as negative, and a reservation as neither', () => {
    expect(signedQuantity('receipt', 4)).toBe(4)
    expect(signedQuantity('return_in', 2)).toBe(2)
    expect(signedQuantity('adjustment_out', 3)).toBe(-3)
    expect(signedQuantity('issue', 1)).toBe(-1)
    expect(signedQuantity('reserve', 5)).toBe(0)
    expect(signedQuantity('release', 5)).toBe(0)
  })
})
