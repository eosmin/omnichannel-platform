import { randomUUID } from 'node:crypto'

import type { OwnerClient } from '@platform/core/database-testing'

import { createCustomer } from './customer'
import { createProduct } from './product'

export interface OrderInput {
  storeId: string
  status?: string
  scheduledDeliveryDate?: Date | null
  customerNotes?: string
  internalNotes?: string
  packingNotes?: string
}

// An order of the store with one line, written as the owner: the way to put an order in any store without the api
export async function createOrder(
  owner: OwnerClient,
  input: OrderInput
): Promise<{ id: string; itemId: string; productId: string }> {
  const customer = await createCustomer(owner, { storeId: input.storeId })
  const product = await createProduct(owner, { storeId: input.storeId })
  const author = await owner.membership.findFirstOrThrow({
    where: { storeId: input.storeId },
    select: { userId: true }
  })
  const order = await owner.order.create({
    data: {
      storeId: input.storeId,
      customerId: customer.id,
      orderNumber: `T-${randomUUID().slice(0, 8)}`,
      status: input.status ?? 'PENDING_CONFIRMATION',
      subtotalCents: 1999,
      totalCents: 1999,
      paymentMethod: 'CASH',
      recipientPhones: ['71234567'],
      createdBy: author.userId,
      ...(input.scheduledDeliveryDate === undefined
        ? {}
        : { scheduledDeliveryDate: input.scheduledDeliveryDate }),
      ...(input.customerNotes === undefined ? {} : { customerNotes: input.customerNotes }),
      ...(input.internalNotes === undefined ? {} : { internalNotes: input.internalNotes }),
      ...(input.packingNotes === undefined ? {} : { packingNotes: input.packingNotes }),
      items: {
        create: {
          productId: product.id,
          productName: product.name,
          quantity: 1,
          unitPriceCents: 1999
        }
      }
    },
    select: { id: true, items: { select: { id: true } } }
  })
  return { id: order.id, itemId: order.items[0]?.id ?? '', productId: product.id }
}

// Remembers which order each allocation is of: an allocation has no route of its own, it is read with its order
export const orderOfAllocation = new Map<string, string>()

// An allocation of a new order of the store, in the first warehouse the store sells from
export async function createAllocationOf(
  owner: OwnerClient,
  input: { storeId: string }
): Promise<{ id: string }> {
  const order = await createOrder(owner, input)
  const link = await owner.storeWarehouse.findFirstOrThrow({
    where: { storeId: input.storeId },
    orderBy: { priority: 'asc' },
    select: { warehouseId: true }
  })
  const allocation = await owner.orderItemAllocation.create({
    data: {
      storeId: input.storeId,
      orderItemId: order.itemId,
      warehouseId: link.warehouseId,
      quantity: 1
    },
    select: { id: true }
  })
  orderOfAllocation.set(allocation.id, order.id)
  return allocation
}
