import { ProductLimits } from '@platform/core/domain'

import {
  inventoryChanges,
  inventoryDraftOf,
  inventoryProblems,
  InventoryProblems
} from './inventory-form'
import type { InventorySettingsView } from './inventory-requests'

const saved: InventorySettingsView = {
  allowNegativeStock: false,
  allowSplitFulfillment: false,
  defaultLowStockThreshold: null
}

describe('inventory settings form', () => {
  it('starts from the saved values, an empty threshold being none', () => {
    expect(inventoryDraftOf(saved)).toEqual({
      allowNegativeStock: false,
      allowSplitFulfillment: false,
      defaultLowStockThreshold: ''
    })
    expect(
      inventoryDraftOf({ ...saved, defaultLowStockThreshold: 0 }).defaultLowStockThreshold
    ).toBe('0')
  })

  it('sends nothing when nothing changed, and only what changed otherwise', () => {
    const draft = inventoryDraftOf(saved)
    expect(inventoryChanges(saved, draft)).toEqual({})
    expect(inventoryChanges(saved, { ...draft, allowNegativeStock: true })).toEqual({
      allowNegativeStock: true
    })
    expect(
      inventoryChanges(saved, {
        ...draft,
        allowSplitFulfillment: true,
        defaultLowStockThreshold: '5'
      })
    ).toEqual({ allowSplitFulfillment: true, defaultLowStockThreshold: 5 })
  })

  it('clears the threshold with null and keeps zero as a number', () => {
    const withThreshold: InventorySettingsView = { ...saved, defaultLowStockThreshold: 4 }
    const draft = inventoryDraftOf(withThreshold)
    expect(inventoryChanges(withThreshold, { ...draft, defaultLowStockThreshold: '' })).toEqual({
      defaultLowStockThreshold: null
    })
    expect(inventoryChanges(withThreshold, { ...draft, defaultLowStockThreshold: ' 0 ' })).toEqual({
      defaultLowStockThreshold: 0
    })
    expect(inventoryChanges(withThreshold, { ...draft, defaultLowStockThreshold: '4' })).toEqual({})
  })

  it.each([
    '-1',
    '1.5',
    '1e2',
    'abc',
    '5 units',
    String(ProductLimits.MAX_LOW_STOCK_THRESHOLD + 1)
  ])('refuses %j as a threshold and sends nothing for it', text => {
    const draft = { ...inventoryDraftOf(saved), defaultLowStockThreshold: text }
    expect(inventoryProblems(draft)).toEqual([InventoryProblems.THRESHOLD])
    expect(inventoryChanges(saved, draft)).toEqual({})
  })

  it.each(['', ' ', '0', '7', String(ProductLimits.MAX_LOW_STOCK_THRESHOLD)])(
    'accepts %j as a threshold',
    text => {
      expect(
        inventoryProblems({ ...inventoryDraftOf(saved), defaultLowStockThreshold: text })
      ).toEqual([])
    }
  )
})
