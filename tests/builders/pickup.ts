import { randomUUID } from 'node:crypto'

import type { OwnerClient } from '@platform/core/database-testing'
import {
  PickupStatus,
  ShipmentEventSource,
  ShipmentStatus,
  ShippingPayer
} from '@platform/core/domain'

import { createCarrierConnection } from './carrier-connection'
import { createOrder } from './order'

// A different day for every pickup built, so two pickups of one connection never share their day
let nextDay = 0

// A guide of a store on a connection that exists (a label made, no pickup), written as the owner: the way to have guides waiting
// for a pickup without asking a carrier for each
export async function createGuideOn(
  owner: OwnerClient,
  input: {
    storeId: string
    connectionId: string
    serviceCode: string
    status?: ShipmentStatus
    packageCount?: number
    pickupId?: string
    // The order the guide belongs to, when it must be more than a confirmed order with no stock behind it (a package that
    // comes back: shipped, paid, a line allocated at a warehouse, an address)
    order?: {
      status?: string
      paymentStatus?: string
      allocatedAt?: string
      shippingAddress?: Record<string, string>
      carrierConnectionId?: string
    }
    guideNumber?: string
    deliveredAt?: Date
  }
): Promise<{
  id: string
  orderId: string
  guideNumber: string
  orderNumber: string
  itemId: string
}> {
  const order = await createOrder(owner, {
    storeId: input.storeId,
    ...input.order,
    status: input.order?.status ?? 'CONFIRMED'
  })
  const orderNumber = (
    await owner.order.findUniqueOrThrow({ where: { id: order.id }, select: { orderNumber: true } })
  ).orderNumber
  const guideNumber = input.guideNumber ?? `G-${randomUUID()}`
  const shipment = await owner.shipment.create({
    data: {
      storeId: input.storeId,
      orderId: order.id,
      connectionId: input.connectionId,
      serviceCode: input.serviceCode,
      shippingPayer: ShippingPayer.SENDER,
      currency: 'USD',
      status: input.status ?? ShipmentStatus.LABEL_CREATED,
      guideNumber,
      packageCount: input.packageCount ?? 1,
      pickupId: input.pickupId ?? null,
      ...(input.deliveredAt === undefined ? {} : { deliveredAt: input.deliveredAt }),
      idempotencyKey: `built-${randomUUID()}`,
      createdBy: 'system'
    },
    select: { id: true }
  })
  await owner.shipmentEvent.create({
    data: {
      storeId: input.storeId,
      shipmentId: shipment.id,
      status: input.status ?? ShipmentStatus.LABEL_CREATED,
      occurredAt: new Date(),
      source: ShipmentEventSource.SYSTEM
    }
  })
  return { id: shipment.id, orderId: order.id, guideNumber, orderNumber, itemId: order.itemId }
}

// A pickup of a store with its own `local` connection and no guides, written as the owner
export async function createPickup(
  owner: OwnerClient,
  input: { storeId: string; status?: PickupStatus; connectionId?: string }
): Promise<{ id: string; connectionId: string }> {
  const connectionId =
    input.connectionId ??
    (
      await createCarrierConnection(owner, {
        storeId: input.storeId,
        prefix: `P${randomUUID()
          .slice(0, 4)
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, '0')}`
      })
    ).id
  const pickup = await owner.pickupRequest.create({
    data: {
      storeId: input.storeId,
      connectionId,
      pickupDate: new Date(Date.UTC(2031, 0, 1 + (nextDay++ % 28))),
      status: input.status ?? PickupStatus.MANUAL_REQUIRED,
      packageCount: 1,
      requestedBy: 'system'
    },
    select: { id: true }
  })
  return { id: pickup.id, connectionId }
}
