import type { OrderCopyView } from '@platform/api-client'
import {
  OrderCopyWarnings,
  type OrderCopyWarningCode,
  type PaymentMethod
} from '@platform/core/domain'

import { centsToInput } from '../products/money'

import { type DraftLine, lineKey } from './order-form'

// The draft of "Copy order" read as the state of the create form (TDD_17 §4.3). The prices are today's catalog ones: no line
// carries a typed price, so the server prices the copy from the catalog like any new order.
export interface CopySeed {
  customerId: string
  lines: DraftLine[]
  shippingText: string
  paymentMethod: PaymentMethod
  phones: string[]
  customerNotes: string
  internalNotes: string
  packingNotes: string
  copiedFromOrderId: string
  shippingAddress: OrderCopyView['draft']['shippingAddress']
}

export function copySeedOf(copy: OrderCopyView): CopySeed {
  const { draft } = copy
  return {
    customerId: draft.customerId,
    lines: copy.lines.map(line => ({
      key: lineKey(line.productId, line.variantId),
      productId: line.productId,
      variantId: line.variantId,
      productName: line.productName,
      variantName: line.variantName,
      sku: null,
      // A line the catalog cannot price any more keeps the price it was sold at, only to draw it
      catalogPriceCents: line.unitPriceCents ?? line.previousUnitPriceCents,
      quantity: String(line.quantity),
      priceText: null,
      priceReason: '',
      allocations: null
    })),
    shippingText: draft.shippingCents === 0 ? '' : centsToInput(draft.shippingCents),
    paymentMethod: draft.paymentMethod as PaymentMethod,
    phones: draft.recipientPhones.length === 0 ? [''] : [...draft.recipientPhones],
    customerNotes: draft.customerNotes ?? '',
    internalNotes: draft.internalNotes ?? '',
    packingNotes: draft.packingNotes ?? '',
    copiedFromOrderId: draft.copiedFromOrderId,
    shippingAddress: draft.shippingAddress
  }
}

export interface CopyWarningRow {
  // The code the server sent when it is one of ours; a code of a newer server is drawn with a general text
  code: OrderCopyWarningCode | null
  productName: string
  variantName: string | null
  // For a price that changed: what the line was sold at, and the catalog price now
  previousCents: number | null
  currentCents: number | null
}

const KNOWN = new Set<string>(Object.values(OrderCopyWarnings))

// The warnings of a draft, one row each, in the order of the lines
export function copyWarningRows(copy: OrderCopyView): CopyWarningRow[] {
  return [...copy.warnings]
    .sort((a, b) => a.itemIndex - b.itemIndex)
    .flatMap(warning => {
      const line = copy.lines[warning.itemIndex]
      if (line === undefined) return []
      const isKnown = KNOWN.has(warning.code)
      return [
        {
          code: isKnown ? (warning.code as OrderCopyWarningCode) : null,
          productName: line.productName,
          variantName: line.variantName,
          previousCents:
            warning.code === OrderCopyWarnings.PRICE_CHANGED ? line.previousUnitPriceCents : null,
          currentCents:
            warning.code === OrderCopyWarnings.PRICE_CHANGED ? line.unitPriceCents : null
        }
      ]
    })
}
