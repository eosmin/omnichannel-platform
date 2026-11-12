import type { PrismaTransaction } from '@platform/core/database'
import {
  CarrierCapability,
  CarrierConnectionStatus,
  type CreateReturnShipmentBody,
  CodStatus,
  defaultRestockWarehouse,
  type LabelFormatType,
  OrderReturnStatus,
  ShipmentInactiveStatuses,
  ShipmentKind,
  ShipmentLimits,
  ShipmentUnknownOutcomeStatuses,
  ShippingPayer,
  returnShipmentIdempotencyKey
} from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import { type CreateShipmentParams, ShipmentCreationModes } from '@platform/plugins/sdk'

import {
  addressLines,
  asRecord,
  carrierAddress,
  type PluginLookup,
  type PreparedGuide,
  type ShipmentCaller,
  shippingRefusal,
  type StoreFacts
} from './shipment-prepare'

// What a caller asks for the guide of the way back: the return and what the agent chose (TDD_17 §4.11)
export interface ReturnShipmentRequest extends CreateReturnShipmentBody {
  returnId: string
}

// The guide of a return leg, read and decided inside the transaction that will write it, like `prepareGuide` does for the way
// out: the same checks of the connection and its service, but the sender is the customer, the recipient is the warehouse the
// goods go to, the guide is never cash on delivery, and what the return already has decides whether another one may be made.
// Throws the refusal of the first rule that fails; writes nothing. The caller has locked the order and the return.
export async function prepareReturnGuide(
  tx: PrismaTransaction,
  store: StoreFacts,
  request: ReturnShipmentRequest,
  caller: ShipmentCaller,
  plugins: PluginLookup
): Promise<PreparedGuide> {
  const { storeId } = store
  const connection = await tx.carrierConnection.findFirst({
    where: { id: request.connectionId, storeId },
    select: {
      id: true,
      carrierId: true,
      status: true,
      credentials: true,
      contact: true,
      labelFormat: true,
      defaultServiceCode: true
    }
  })
  if (connection === null) throw resourceNotFound('carrier')
  const plugin = plugins(connection.carrierId)
  if (connection.status !== String(CarrierConnectionStatus.ACTIVE) || plugin === undefined) {
    throw shippingRefusal(
      ErrorCodes.SHIPPING_CARRIER_NOT_ACTIVE,
      'the carrier connection is not active'
    )
  }
  // Only what the plugin declares is asked of it (never decided by the carrier's name), and the guide is made with
  // `createShipment`, so the plugin must make standalone guides (the registry checks the same at boot)
  if (
    !plugin.capabilities.includes(CarrierCapability.RETURN_SHIPMENT) ||
    plugin.shipmentCreation !== ShipmentCreationModes.STANDALONE ||
    plugin.createShipment === undefined
  ) {
    throw shippingRefusal(
      ErrorCodes.SHIPPING_CARRIER_CAPABILITY_MISSING,
      'the carrier cannot make the guide of a return'
    )
  }

  const orderReturn = await tx.orderReturn.findFirst({
    where: { id: request.returnId, storeId },
    select: {
      id: true,
      status: true,
      shippingPayer: true,
      order: {
        select: {
          id: true,
          orderNumber: true,
          shippingAddress: true,
          recipientPhones: true,
          currency: true,
          customer: { select: { name: true } }
        }
      },
      lines: {
        select: {
          quantity: true,
          orderItem: { select: { allocations: { select: { warehouseId: true, quantity: true } } } }
        }
      }
    }
  })
  if (orderReturn === null) throw resourceNotFound('return')
  // The goods are not on their way yet: the guide is made for an approved return, never one that is over or not yet decided
  if (orderReturn.status !== String(OrderReturnStatus.APPROVED)) {
    throw new PlatformException(
      ErrorCodes.RETURN_INVALID_STATUS_TRANSITION,
      'a return leg is made for an approved return',
      HttpStatusCodes.CONFLICT
    )
  }
  const { order } = orderReturn
  const origin = asRecord(order.shippingAddress)
  const customerAddress = origin === null ? null : carrierAddress(origin)
  if (origin === null || customerAddress === null) {
    throw shippingRefusal(ErrorCodes.SHIPPING_ADDRESS_MISSING, 'the order has no shipping address')
  }

  const services = await tx.carrierService.findMany({
    where: { connectionId: connection.id, storeId },
    select: { code: true, label: true, active: true },
    orderBy: { code: 'asc' }
  })
  const wanted = request.serviceCode ?? connection.defaultServiceCode
  const service =
    wanted === null
      ? services.find(entry => entry.active)
      : services.find(entry => entry.code === wanted)
  if (service === undefined || !service.active) {
    throw shippingRefusal(
      ErrorCodes.SHIPPING_SERVICE_INVALID,
      'the service is not an active one of the carrier'
    )
  }

  // The destination: the warehouse the agent chose, else the one that sent most of the returned units (the one a resellable
  // unit goes back to by default), else the first warehouse of the store
  const sent = orderReturn.lines.flatMap(line =>
    line.orderItem.allocations.map(allocation => ({
      warehouseId: allocation.warehouseId,
      quantity: allocation.quantity
    }))
  )
  let destinationId = request.warehouseId ?? defaultRestockWarehouse(sent)
  if (destinationId === null) {
    const first = await tx.storeWarehouse.findFirst({
      where: { storeId, warehouse: { active: true } },
      orderBy: { priority: 'asc' },
      select: { warehouseId: true }
    })
    destinationId = first?.warehouseId ?? null
  }
  const warehouse =
    destinationId === null
      ? null
      : await tx.warehouse.findFirst({
          where: {
            id: destinationId,
            active: true,
            organizationId: store.organizationId,
            stores: { some: { storeId } }
          },
          select: { id: true, name: true, address: true }
        })
  const warehouseAddress = warehouse === null ? null : asRecord(warehouse.address)
  const destination = warehouseAddress === null ? null : carrierAddress(warehouseAddress)
  if (warehouse === null || warehouseAddress === null || destination === null) {
    throw shippingRefusal(
      ErrorCodes.SHIPPING_ORIGIN_MISSING,
      'the destination warehouse has no address, is not active or is not linked to the store'
    )
  }

  // What the return already has: a guide whose outcome is unknown stops a new one, and so does any active one
  const existing = await tx.shipment.findMany({
    where: {
      returnId: orderReturn.id,
      storeId,
      kind: ShipmentKind.RETURN,
      status: { notIn: [...ShipmentInactiveStatuses] }
    },
    select: { status: true }
  })
  const active = existing[0]
  if (active !== undefined) {
    const unknown = ShipmentUnknownOutcomeStatuses.some(status => String(status) === active.status)
    throw shippingRefusal(
      unknown ? ErrorCodes.SHIPPING_OUTCOME_UNKNOWN : ErrorCodes.SHIPPING_ACTIVE_SHIPMENT_EXISTS,
      unknown
        ? 'a guide of the return may exist at the carrier'
        : 'the return already has an active guide'
    )
  }
  const attempt =
    (await tx.shipment.count({
      where: { returnId: orderReturn.id, storeId, kind: ShipmentKind.RETURN }
    })) + 1
  const idempotencyKey = returnShipmentIdempotencyKey(orderReturn.id, attempt)

  const contact = asRecord(connection.contact)
  const warehousePhone = typeof contact?.['phone'] === 'string' ? contact['phone'] : undefined
  const customerName = order.customer.name?.trim() || order.orderNumber
  const customerPhone = order.recipientPhones[0] ?? ''
  const labelFormat = connection.labelFormat as LabelFormatType
  // What the agent wrote for the courier: one line, bounded (the schema does that for the request)
  const notes =
    request.notes === undefined || request.notes === ''
      ? undefined
      : request.notes.slice(0, ShipmentLimits.NOTES_MAX_LENGTH)
  // The payer of a return is said as the guides of the store say it (TDD_17 §4.11: the replacement's guide uses the same one):
  // SENDER is the store, RECIPIENT the customer. The sender of THIS guide is the customer, so the sides swap: when the store
  // pays, the one the carrier bills is the recipient of the guide (the warehouse), and when the customer pays, its sender.
  const shippingPayer =
    orderReturn.shippingPayer === String(ShippingPayer.SENDER)
      ? ShippingPayer.RECIPIENT
      : ShippingPayer.SENDER

  const params: CreateShipmentParams = {
    reference: order.orderNumber,
    idempotencyKey,
    kind: ShipmentKind.RETURN,
    sender: { name: customerName, address: customerAddress, phone: customerPhone },
    recipient: {
      name: warehouse.name,
      phones: warehousePhone === undefined ? [] : [warehousePhone],
      address: destination,
      ...(request.locationIds === undefined ? {} : { locationIds: request.locationIds })
    },
    packageCount: 1,
    parcels: [{}],
    serviceCode: service.code,
    shippingPayer,
    cod: null,
    labelFormat,
    ...(notes === undefined ? {} : { notes })
  }

  return {
    identity: {
      storeId,
      orderId: order.id,
      orderNumber: order.orderNumber,
      connectionId: connection.id
    },
    row: {
      storeId,
      orderId: order.id,
      connectionId: connection.id,
      kind: ShipmentKind.RETURN,
      returnId: orderReturn.id,
      originWarehouseId: null,
      serviceCode: service.code,
      shippingPayer,
      codAmountCents: null,
      codStatus: CodStatus.NOT_APPLICABLE,
      currency: order.currency,
      packageCount: 1,
      idempotencyKey,
      createdBy: caller.actor.id ?? 'system'
    },
    params,
    plugin,
    connection: {
      id: connection.id,
      carrierId: connection.carrierId,
      credentials: connection.credentials,
      contact: connection.contact,
      labelFormat
    },
    label: {
      senderName: customerName,
      senderPhone: customerPhone === '' ? undefined : customerPhone,
      senderLines: addressLines(origin),
      recipientName: warehouse.name,
      recipientLines: addressLines(warehouseAddress),
      recipientPhones: warehousePhone === undefined ? [] : [warehousePhone],
      serviceLabel: service.label,
      notes,
      codAmountCents: null,
      currency: order.currency
    }
  }
}
