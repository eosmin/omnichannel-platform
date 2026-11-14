import { randomUUID } from 'node:crypto'

import type { OwnerClient } from '@platform/core/database-testing'
import {
  CodStatus,
  ShipmentEventSource,
  ShipmentStatus,
  ShippingPayer
} from '@platform/core/domain'

import { BUILT_SERVICE_CODE, createCarrierConnection } from './carrier-connection'
import { createOrder } from './order'

export interface ShipmentInput {
  storeId: string
  status?: ShipmentStatus
  // A connection that already exists (its guide numbers are then the caller's): the default is a new one of its own
  connectionId?: string
  guideNumber?: string
  // The cash on delivery of the guide and where it stands (TDD_17 §4.15)
  codAmountCents?: number
  codStatus?: CodStatus
  codExpectedCents?: number
  codRemittedCents?: number
  carrierCostCents?: number
  // What the connection agreed when the guide was made (TDD_17 §4.15): the rate of its service and the commission in basis points
  carrierRateCents?: number
  commissionBps?: number
  shippingPayer?: ShippingPayer
  deliveredAt?: Date
}

// A shipment of a store with its order, its `local` connection and the first row of its history, written as the owner: the
// way to put a guide in any store without the api. The guide is one nobody else has.
export async function createShipment(
  owner: OwnerClient,
  input: ShipmentInput
): Promise<{ id: string; orderId: string; connectionId: string; eventId: string }> {
  // A COD state is only valid with the amount to collect (the database checks the pair): a caller that gives one alone is wrong
  if (input.codStatus !== undefined && input.codAmountCents === undefined) {
    throw new Error('createShipment: codStatus needs codAmountCents')
  }
  const order = await createOrder(owner, { storeId: input.storeId, status: 'CONFIRMED' })
  const connection =
    input.connectionId === undefined
      ? await createCarrierConnection(owner, {
          storeId: input.storeId,
          prefix: `S${randomUUID()
            .slice(0, 4)
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, '0')}`
        })
      : { id: input.connectionId, serviceCode: BUILT_SERVICE_CODE }
  const shipment = await owner.shipment.create({
    data: {
      storeId: input.storeId,
      orderId: order.id,
      connectionId: connection.id,
      serviceCode: connection.serviceCode,
      shippingPayer: input.shippingPayer ?? ShippingPayer.SENDER,
      ...(input.codAmountCents === undefined
        ? {}
        : {
            codAmountCents: input.codAmountCents,
            codStatus: input.codStatus ?? CodStatus.NOT_DELIVERED
          }),
      ...(input.codExpectedCents === undefined ? {} : { codExpectedCents: input.codExpectedCents }),
      ...(input.codRemittedCents === undefined ? {} : { codRemittedCents: input.codRemittedCents }),
      ...(input.carrierCostCents === undefined ? {} : { carrierCostCents: input.carrierCostCents }),
      ...(input.carrierRateCents === undefined ? {} : { carrierRateCents: input.carrierRateCents }),
      ...(input.commissionBps === undefined ? {} : { commissionBps: input.commissionBps }),
      ...(input.deliveredAt === undefined ? {} : { deliveredAt: input.deliveredAt }),
      currency: 'USD',
      status: input.status ?? ShipmentStatus.LABEL_CREATED,
      guideNumber: input.guideNumber ?? `G-${randomUUID()}`,
      idempotencyKey: `built-${randomUUID()}`,
      createdBy: 'system'
    },
    select: { id: true }
  })
  const event = await owner.shipmentEvent.create({
    data: {
      storeId: input.storeId,
      shipmentId: shipment.id,
      status: input.status ?? ShipmentStatus.LABEL_CREATED,
      occurredAt: new Date(),
      source: ShipmentEventSource.SYSTEM
    },
    select: { id: true }
  })
  return { id: shipment.id, orderId: order.id, connectionId: connection.id, eventId: event.id }
}
