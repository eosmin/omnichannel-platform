import { planLineAllocation } from './order-allocation'
import { type OrderCopyWarningCode, OrderCopyWarnings } from './order-constants'
import { orderShippingAddressSchema, type CreateOrderInput } from './order-schemas'

// The draft of "Copy order" (TDD_17 §4.3), built without a database so the rules are tested on their own: what carries
// over from the earlier order, what is read again from the catalog today, and what is worth a warning. It writes nothing;
// the agent edits the draft and submits it through the normal create path, where every rule applies again.

export interface CopySourceItem {
  productId: string
  variantId: string | null
  productName: string
  variantName: string | null
  quantity: number
  // What the customer paid per unit, an override included
  unitPriceCents: number
  // Null unless the price was overridden: then the catalog price the line had
  originalUnitPriceCents: number | null
}

export interface CopySourceOrder {
  id: string
  // The customer the new order is for: the survivor when the one of the old order was merged
  customerId: string
  shippingCents: number
  paymentMethod: CreateOrderInput['paymentMethod']
  shippingAddress: unknown
  recipientPhones: readonly string[]
  customerNotes: string | null
  internalNotes: string | null
  packingNotes: string | null
  items: readonly CopySourceItem[]
}

export interface CopyCatalogProduct {
  id: string
  active: boolean
  priceCents: number
  trackInventory: boolean
  variants: readonly { id: string; active: boolean; priceCents: number | null }[]
}

export interface CopyStock {
  // The warehouses the store sells from, switched on, the highest priority first (what a reservation walks)
  warehouseIds: readonly string[]
  // Units that can still be promised (onHand - reserved) by `copyStockKey`; a level that does not exist is not there
  available: ReadonlyMap<string, number>
  allowSplitFulfillment: boolean
  allowNegativeStock: boolean
}

export function copyStockKey(
  productId: string,
  variantId: string | null,
  warehouseId: string
): string {
  return `${productId}:${variantId ?? ''}:${warehouseId}`
}

export interface OrderCopyLine {
  productId: string
  variantId: string | null
  productName: string
  variantName: string | null
  quantity: number
  // Today's catalog price: the price of the new order is never the one of the old (null when the line cannot be priced now)
  unitPriceCents: number | null
  // What the catalog price of this line was when the old order was made
  previousUnitPriceCents: number
}

export interface OrderCopyWarning {
  code: OrderCopyWarningCode
  // The position of the line in `draft.items`
  itemIndex: number
  productId: string
  variantId: string | null
}

export interface OrderCopyDraft {
  // Shaped as the body of `POST /orders`: no prices (the server reads them), no discount (a price decision of its own), no
  // scheduled day (a day of the past), no carrier (the store's default is planned again) and no thread
  draft: Pick<
    CreateOrderInput,
    | 'customerId'
    | 'items'
    | 'shippingCents'
    | 'paymentMethod'
    | 'recipientPhones'
    | 'customerNotes'
    | 'internalNotes'
    | 'packingNotes'
    | 'shippingAddress'
    | 'copiedFromOrderId'
  >
  lines: OrderCopyLine[]
  warnings: OrderCopyWarning[]
}

export function buildOrderCopyDraft(
  order: CopySourceOrder,
  catalog: readonly CopyCatalogProduct[],
  stock: CopyStock
): OrderCopyDraft {
  const lines: OrderCopyLine[] = []
  const warnings: OrderCopyWarning[] = []

  order.items.forEach((item, itemIndex) => {
    const warn = (code: OrderCopyWarningCode) =>
      warnings.push({ code, itemIndex, productId: item.productId, variantId: item.variantId })
    const previous = item.originalUnitPriceCents ?? item.unitPriceCents
    const product = catalog.find(row => row.id === item.productId)
    const variant =
      item.variantId === null ? undefined : product?.variants.find(row => row.id === item.variantId)

    let current: number | null = null
    if (product === undefined || !product.active) {
      warn(OrderCopyWarnings.PRODUCT_INACTIVE)
    } else if (item.variantId !== null && (variant === undefined || !variant.active)) {
      warn(OrderCopyWarnings.VARIANT_UNAVAILABLE)
    } else if (item.variantId === null && product.variants.some(row => row.active)) {
      warn(OrderCopyWarnings.VARIANT_REQUIRED)
    } else {
      // A variant with no price of its own sells at the price of its product
      current = variant?.priceCents ?? product.priceCents
      if (current !== previous) warn(OrderCopyWarnings.PRICE_CHANGED)
      // The same plan the reservation will make, so a line is warned about exactly when the create would refuse it
      if (product.trackInventory) {
        const plan = planLineAllocation({
          quantity: item.quantity,
          warehouses: stock.warehouseIds.map(warehouseId => ({
            warehouseId,
            available:
              stock.available.get(copyStockKey(item.productId, item.variantId, warehouseId)) ?? 0
          })),
          allowSplitFulfillment: stock.allowSplitFulfillment,
          allowNegativeStock: stock.allowNegativeStock
        })
        if (!plan.ok) warn(OrderCopyWarnings.OUT_OF_STOCK)
      }
    }
    lines.push({
      productId: item.productId,
      variantId: item.variantId,
      productName: item.productName,
      variantName: item.variantName,
      quantity: item.quantity,
      unitPriceCents: current,
      previousUnitPriceCents: previous
    })
  })

  const address = orderShippingAddressSchema.safeParse(order.shippingAddress)
  return {
    draft: {
      customerId: order.customerId,
      items: order.items.map(item => ({
        productId: item.productId,
        ...(item.variantId === null ? {} : { variantId: item.variantId }),
        quantity: item.quantity
      })),
      shippingCents: order.shippingCents,
      paymentMethod: order.paymentMethod,
      recipientPhones: [...order.recipientPhones],
      ...(address.success ? { shippingAddress: address.data } : {}),
      ...(order.customerNotes === null ? {} : { customerNotes: order.customerNotes }),
      ...(order.internalNotes === null ? {} : { internalNotes: order.internalNotes }),
      ...(order.packingNotes === null ? {} : { packingNotes: order.packingNotes }),
      copiedFromOrderId: order.id
    },
    lines,
    warnings
  }
}
