import { ProductLimits } from '@platform/core/domain'

import type { InventorySettingsInput, InventorySettingsView } from './inventory-requests'

// The form of Settings → Inventory as plain values, and the checks done before the request. The api checks
// the same and decides.

export interface InventoryDraft {
  allowNegativeStock: boolean
  allowSplitFulfillment: boolean
  // Digits as typed; empty is "no default threshold"
  defaultLowStockThreshold: string
}

export const InventoryProblems = {
  THRESHOLD: 'threshold'
} as const
export type InventoryProblem = (typeof InventoryProblems)[keyof typeof InventoryProblems]

export function inventoryDraftOf(view: InventorySettingsView): InventoryDraft {
  return {
    allowNegativeStock: view.allowNegativeStock,
    allowSplitFulfillment: view.allowSplitFulfillment,
    defaultLowStockThreshold:
      view.defaultLowStockThreshold === null ? '' : String(view.defaultLowStockThreshold)
  }
}

// Empty is none (null); otherwise digits only ('1e2' and '7.5' are not quantities) inside the limit. Undefined is
// a text that is neither.
function thresholdOf(text: string): number | null | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (!/^\d+$/.test(trimmed)) return undefined
  const value = Number(trimmed)
  return value <= ProductLimits.MAX_LOW_STOCK_THRESHOLD ? value : undefined
}

export function inventoryProblems(draft: InventoryDraft): InventoryProblem[] {
  return thresholdOf(draft.defaultLowStockThreshold) === undefined
    ? [InventoryProblems.THRESHOLD]
    : []
}

// Only what the person changed: a switch they never touched must not overwrite what another person saved
export function inventoryChanges(
  saved: InventorySettingsView,
  draft: InventoryDraft
): InventorySettingsInput {
  const changes: InventorySettingsInput = {}
  if (draft.allowNegativeStock !== saved.allowNegativeStock) {
    changes.allowNegativeStock = draft.allowNegativeStock
  }
  if (draft.allowSplitFulfillment !== saved.allowSplitFulfillment) {
    changes.allowSplitFulfillment = draft.allowSplitFulfillment
  }
  const threshold = thresholdOf(draft.defaultLowStockThreshold)
  if (threshold !== undefined && threshold !== saved.defaultLowStockThreshold) {
    changes.defaultLowStockThreshold = threshold
  }
  return changes
}
