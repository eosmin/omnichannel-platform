import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import type { OwnerClient } from '@platform/core/database-testing'
import { InventoryAdjustmentReason, PaymentMethod } from '@platform/core/domain'

import { createCustomer, createProduct } from '../builders'

import type { TestContext } from './context'
import { api, type TestAgent } from './http'

const CREATED = 201

export interface ErrorBody {
  error: { code: string; metadata?: Record<string, unknown> }
}

export interface OrderBody {
  id: string
  orderNumber: string
  status: string
  customerId: string
  subtotalCents: number
  shippingCents: number
  discountCents: number
  totalCents: number
  paymentMethod: string
  paymentStatus: string
  paymentReference: string | null
  freeShipping: boolean
  discountReason: string | null
  priceApprovalStatus: string
  priceApprovalRequestedBy: string | null
  priceApprovedBy: string | null
  priceApprovedDiscountCents: number | null
  confirmedVia: string | null
  copiedFromOrderId: string | null
  customerNotes?: string | null
  internalNotes?: string | null
  packingNotes?: string | null
  recipientPhones: string[]
  scheduledDeliveryDate: string | null
  priceModified: boolean
  customer: { id: string; nationalPhone: string | null }
  items: {
    id: string
    productId: string
    variantId: string | null
    quantity: number
    unitPriceCents: number
    originalUnitPriceCents: number | null
    priceOverrideReason: string | null
    allocations: { warehouseId: string; quantity: number }[]
  }[]
}

export interface CreatedBody {
  order: OrderBody
  notices: string[]
}

export interface PageBody {
  data: { id: string; orderNumber: string; scheduledDeliveryDate: string | null }[]
  nextCursor: string | null
  hasMore: boolean
}

// A valid body of POST /orders, with what a test changes on top of it
export type OrderRequest = {
  customerId: string
  items: { productId: string; quantity: number }[]
  paymentMethod: string
  recipientPhones: string[]
} & Record<string, unknown>

export interface OrdersKit {
  asAdmin: () => TestAgent
  receive: (
    productId: string,
    warehouseId: string,
    quantity: number,
    variantId?: string
  ) => Promise<void>
  stocked: (
    first: number,
    second?: number,
    priceCents?: number
  ) => Promise<{ id: string; name: string }>
  customer: () => Promise<{ id: string; name: string }>
  orderBody: (extra?: Record<string, unknown>) => Promise<OrderRequest>
  level: (
    productId: string,
    warehouseId: string,
    variantId?: string | null
  ) => Promise<{ onHand: number; reserved: number } | null>
  resetSettings: () => Promise<void>
}

// What the orders suites share: a product with stock in the warehouses of store A, a customer, a valid body
export function ordersKit(owner: OwnerClient, app: INestApplication, ctx: TestContext): OrdersKit {
  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)

  async function receive(
    productId: string,
    warehouseId: string,
    quantity: number,
    variantId?: string
  ) {
    const response = await asAdmin()
      .post(ApiRoutes.inventory.adjustments)
      .send({
        warehouseId,
        productId,
        ...(variantId === undefined ? {} : { variantId }),
        type: 'receipt',
        quantity,
        reason: InventoryAdjustmentReason.OPENING_STOCK,
        idempotencyKey: randomUUID()
      })
    expect(response.status).toBe(CREATED)
  }

  // A product of store A with `first` units in the warehouse of priority 1 and `second` in the one of priority 2
  async function stocked(first: number, second = 0, priceCents = 1000) {
    const product = await createProduct(owner, { storeId: ctx.storeA.id, priceCents })
    if (first > 0) await receive(product.id, ctx.warehouseA.id, first)
    if (second > 0) await receive(product.id, ctx.warehouseASecond.id, second)
    return product
  }

  async function customer() {
    return createCustomer(owner, { storeId: ctx.storeA.id, phone: '+50371234567' })
  }

  async function orderBody(extra: Record<string, unknown> = {}) {
    const product = await stocked(10)
    return {
      customerId: (await customer()).id,
      items: [{ productId: product.id, quantity: 2 }],
      paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
      recipientPhones: ['71234567'],
      ...extra
    }
  }

  const level = (productId: string, warehouseId: string, variantId: string | null = null) =>
    owner.inventoryLevel.findFirst({ where: { productId, warehouseId, variantId } })

  // The settings of store A back to the factory state: a test that turns something on never leaks it into the next one
  async function resetSettings() {
    await owner.storeSettings.update({
      where: { storeId: ctx.storeA.id },
      data: { allowNegativeStock: false, allowSplitFulfillment: false, preferences: {} }
    })
  }

  return { asAdmin, receive, stocked, customer, orderBody, level, resetSettings }
}
