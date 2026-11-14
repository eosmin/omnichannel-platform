import type { PrismaTransaction } from '@platform/core/database'
import {
  CarrierCapability,
  CarrierConnectionStatus,
  DEFAULT_PHONE_REGION,
  type CreateShipmentBody,
  isShippingFeeWithinRange,
  rateCentsOf,
  CodStatus,
  PaymentMethod,
  PaymentStatus,
  ShipmentInactiveStatuses,
  ShipmentLimits,
  ShipmentKind,
  ShipmentUnknownOutcomeStatuses,
  ShippingFeeBoundKinds,
  ShippingPayer,
  shipmentIdempotencyKey,
  type LabelFormatType
} from '@platform/core/domain'
import {
  ErrorCodes,
  type ErrorCode,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import {
  type CarrierAddress,
  type CarrierPlugin,
  type CreateShipmentParams,
  ShipmentCreationModes
} from '@platform/plugins/sdk'

import {
  clampCarrierMessage,
  codAmountFor,
  creationCapabilityOf,
  isFeeAcceptedForGuide,
  orderBlockOf,
  rateServiceOf
} from './shipment-rules'
import type { ShipmentIdentity } from './shipment-writes'

// Everything that decides whether an order gets a guide, read inside the transaction that will write it (TDD_17 §4.5 step 1):
// the order, the connection, the origin and what the order already has. Nothing here writes.

export type PluginLookup = (carrierId: string) => CarrierPlugin | undefined

// What a caller asks for one guide: the body of the route plus the order it is for
export interface ShipmentRequest extends CreateShipmentBody {
  orderId: string
}

export interface ShipmentCaller {
  actor: { type: 'user' | 'system'; id: string | null }
  // The caller holds ORDERS_OVERRIDE_PRICE: a fee out of the range of the carrier does not stop the guide (TDD_17 §4.13)
  canOverridePrice: boolean
}

export interface StoreFacts {
  storeId: string
  organizationId: string
  timezone: string
  locale: string
}

// The refusals of this step carry the status each one is answered with
const REFUSAL_STATUS: Partial<Record<ErrorCode, number>> = {
  [ErrorCodes.SHIPPING_ORDER_NOT_CONFIRMED]: HttpStatusCodes.CONFLICT,
  [ErrorCodes.ORDER_PRICE_APPROVAL_PENDING]: HttpStatusCodes.CONFLICT,
  [ErrorCodes.SHIPPING_ACTIVE_SHIPMENT_EXISTS]: HttpStatusCodes.CONFLICT,
  [ErrorCodes.SHIPPING_OUTCOME_UNKNOWN]: HttpStatusCodes.CONFLICT,
  [ErrorCodes.SHIPPING_CARRIER_NOT_ACTIVE]: HttpStatusCodes.CONFLICT,
  [ErrorCodes.SHIPPING_CARRIER_CAPABILITY_MISSING]: HttpStatusCodes.CONFLICT,
  [ErrorCodes.SHIPPING_FEE_OUT_OF_RANGE]: HttpStatusCodes.CONFLICT,
  [ErrorCodes.SHIPPING_ORIGIN_MISSING]: HttpStatusCodes.BAD_REQUEST,
  [ErrorCodes.SHIPPING_ORIGIN_AMBIGUOUS]: HttpStatusCodes.BAD_REQUEST,
  [ErrorCodes.SHIPPING_LOCATION_REQUIRED]: HttpStatusCodes.BAD_REQUEST,
  [ErrorCodes.SHIPPING_ADDRESS_MISSING]: HttpStatusCodes.BAD_REQUEST,
  [ErrorCodes.SHIPPING_RECIPIENT_PHONE_MISSING]: HttpStatusCodes.BAD_REQUEST,
  [ErrorCodes.SHIPPING_CARRIER_REQUIRED]: HttpStatusCodes.BAD_REQUEST,
  [ErrorCodes.SHIPPING_SERVICE_INVALID]: HttpStatusCodes.BAD_REQUEST
}

export function shippingRefusal(code: ErrorCode, message: string): PlatformException {
  return new PlatformException(code, message, REFUSAL_STATUS[code] ?? HttpStatusCodes.BAD_REQUEST)
}

// The pieces the `local` label is drawn from, already localized except for the words (the service adds those)
export interface LabelParts {
  senderName: string
  senderPhone: string | undefined
  senderLines: readonly string[]
  recipientName: string
  recipientLines: readonly string[]
  recipientPhones: readonly string[]
  serviceLabel: string
  notes: string | undefined
  codAmountCents: number | null
  currency: string
}

export interface PreparedGuide {
  identity: Omit<ShipmentIdentity, 'shipmentId'>
  row: {
    storeId: string
    orderId: string
    connectionId: string
    kind: ShipmentKind
    // Set on the guide of a return leg: the return it belongs to (`Shipment.returnId`)
    returnId?: string
    originWarehouseId: string | null
    serviceCode: string
    shippingPayer: ShippingPayer
    codAmountCents: number | null
    codStatus: CodStatus
    currency: string
    packageCount: number
    // What the connection agreed with the carrier when the guide was made (§4.15): the rate of the service and the commission
    carrierRateCents: number | null
    commissionBps: number | null
    idempotencyKey: string
    createdBy: string
  }
  params: CreateShipmentParams
  plugin: CarrierPlugin
  connection: {
    id: string
    carrierId: string
    credentials: Uint8Array | null
    contact: unknown
    labelFormat: LabelFormatType
  }
  label: LabelParts
}

export function addressLines(address: Record<string, unknown>): string[] {
  const text = (key: string): string => {
    const value = address[key]
    return typeof value === 'string' ? value.trim() : ''
  }
  const place = [text('city'), text('state')].filter(part => part !== '').join(', ')
  const tail = [text('postalCode'), text('country')].filter(part => part !== '').join(' ')
  return [text('line1'), text('line2'), place, tail].filter(line => line !== '')
}

export function carrierAddress(address: Record<string, unknown>): CarrierAddress | null {
  const text = (key: string): string | undefined => {
    const value = address[key]
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  }
  const line1 = text('line1')
  const city = text('city')
  if (line1 === undefined || city === undefined) return null
  const line2 = text('line2')
  const region = text('state')
  const postalCode = text('postalCode')
  return {
    line1,
    ...(line2 === undefined ? {} : { line2 }),
    city,
    ...(region === undefined ? {} : { region }),
    ...(postalCode === undefined ? {} : { postalCode }),
    country: text('country') ?? DEFAULT_PHONE_REGION
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null
}

// Reads what a guide needs and decides, in the order of TDD_17 §4.5 step 1. Throws the refusal of the first rule that
// fails; writes nothing.
export async function prepareGuide(
  tx: PrismaTransaction,
  store: StoreFacts,
  request: ShipmentRequest,
  caller: ShipmentCaller,
  plugins: PluginLookup,
  connectionId: string
): Promise<PreparedGuide> {
  const { storeId } = store
  const connection = await tx.carrierConnection.findFirst({
    where: { id: connectionId, storeId },
    select: {
      id: true,
      carrierId: true,
      status: true,
      credentials: true,
      contact: true,
      labelFormat: true,
      defaultServiceCode: true,
      defaultShippingPayer: true,
      minShippingFeeCents: true,
      maxShippingFeeCents: true,
      commissionBps: true,
      serviceRatesCents: true
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
  if (!plugin.capabilities.includes(creationCapabilityOf(plugin.shipmentCreation))) {
    throw shippingRefusal(
      ErrorCodes.SHIPPING_CARRIER_CAPABILITY_MISSING,
      'the carrier cannot make guides'
    )
  }

  // The plugin declares a mode and a capability: what it declares it must be able to do (a registry that failed at boot would
  // have said so; this is the last check before a row is written and a guide may be asked for)
  const missing =
    (plugin.shipmentCreation === ShipmentCreationModes.STANDALONE &&
      plugin.createShipment === undefined) ||
    (plugin.shipmentCreation === ShipmentCreationModes.PICKUP_BOUND &&
      plugin.createShipmentsWithPickup === undefined) ||
    (plugin.shipmentCreation === ShipmentCreationModes.INTERNAL &&
      plugin.buildLabelLayout === undefined)
  if (missing) {
    throw shippingRefusal(
      ErrorCodes.SHIPPING_CARRIER_CAPABILITY_MISSING,
      'the carrier declares a way to make guides that it does not have'
    )
  }

  const order = await tx.order.findFirst({
    where: { id: request.orderId, storeId },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      priceApprovalStatus: true,
      priceApprovedShippingCents: true,
      shippingAddress: true,
      recipientPhones: true,
      customerNotes: true,
      shippingCents: true,
      subtotalCents: true,
      discountCents: true,
      totalCents: true,
      freeShipping: true,
      paymentMethod: true,
      paymentStatus: true,
      currency: true,
      customer: { select: { name: true, email: true } },
      items: {
        select: {
          unitPriceCents: true,
          allocations: { select: { warehouseId: true, quantity: true } }
        }
      }
    }
  })
  if (order === null) throw resourceNotFound('order')
  const blocked = orderBlockOf(order)
  if (blocked !== null) throw shippingRefusal(blocked, 'the order cannot get a guide now')
  const destination = asRecord(order.shippingAddress)
  const recipientAddress = destination === null ? null : carrierAddress(destination)
  if (destination === null || recipientAddress === null) {
    throw shippingRefusal(ErrorCodes.SHIPPING_ADDRESS_MISSING, 'the order has no shipping address')
  }

  // An order with nothing to pay (a credit covered all of it) collects nothing, whatever its method and the state of its payment
  const collects =
    order.paymentMethod === String(PaymentMethod.CASH_ON_DELIVERY) &&
    order.paymentStatus !== String(PaymentStatus.COMPLETED) &&
    order.totalCents > 0
  if (collects && !plugin.capabilities.includes(CarrierCapability.COD)) {
    throw shippingRefusal(
      ErrorCodes.SHIPPING_CARRIER_CAPABILITY_MISSING,
      'the carrier cannot collect cash on delivery'
    )
  }
  if (
    plugin.capabilities.includes(CarrierCapability.REQUIRES_LOCATION_IDS) &&
    request.locationIds === undefined
  ) {
    throw shippingRefusal(ErrorCodes.SHIPPING_LOCATION_REQUIRED, 'the carrier needs location ids')
  }

  // The fee the customer was charged against the range of the connection that will carry the guide (TDD_17 §4.13)
  const withinRange = isShippingFeeWithinRange(order.shippingCents, order.freeShipping, {
    kind: ShippingFeeBoundKinds.CARRIER,
    minCents: connection.minShippingFeeCents,
    maxCents: connection.maxShippingFeeCents
  })
  if (
    !isFeeAcceptedForGuide({
      feeCents: order.shippingCents,
      freeShipping: order.freeShipping,
      withinRange,
      approvedShippingCents: order.priceApprovedShippingCents,
      approvalStatus: order.priceApprovalStatus,
      canOverridePrice: caller.canOverridePrice
    })
  ) {
    throw shippingRefusal(
      ErrorCodes.SHIPPING_FEE_OUT_OF_RANGE,
      'the shipping fee is outside the range of the carrier'
    )
  }

  const services = await tx.carrierService.findMany({
    where: { connectionId, storeId },
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

  // The origin: the warehouse the lines leave from (TDD_17 §4.5 step 1)
  const values = new Map<string, number>()
  for (const item of order.items) {
    for (const allocation of item.allocations) {
      values.set(
        allocation.warehouseId,
        (values.get(allocation.warehouseId) ?? 0) + allocation.quantity * item.unitPriceCents
      )
    }
  }
  let origins = [...values.entries()].map(([warehouseId, linesCents]) => ({
    warehouseId,
    linesCents
  }))
  if (origins.length === 0) {
    const first = await tx.storeWarehouse.findFirst({
      where: { storeId, warehouse: { active: true } },
      orderBy: { priority: 'asc' },
      select: { warehouseId: true }
    })
    if (first === null) {
      throw shippingRefusal(ErrorCodes.SHIPPING_ORIGIN_MISSING, 'the store has no origin warehouse')
    }
    origins = [{ warehouseId: first.warehouseId, linesCents: order.subtotalCents }]
  }
  const chosen =
    request.originWarehouseId ?? (origins.length === 1 ? origins[0]?.warehouseId : undefined)
  if (chosen === undefined) {
    throw shippingRefusal(
      ErrorCodes.SHIPPING_ORIGIN_AMBIGUOUS,
      'the lines leave from more than one warehouse: say which one makes the guide'
    )
  }
  if (!origins.some(origin => origin.warehouseId === chosen)) {
    throw shippingRefusal(
      ErrorCodes.SHIPPING_ORIGIN_MISSING,
      'the warehouse asked for is not one the lines of the order leave from'
    )
  }
  const warehouse = await tx.warehouse.findFirst({
    where: {
      id: chosen,
      organizationId: store.organizationId,
      stores: { some: { storeId } }
    },
    select: { id: true, name: true, address: true }
  })
  const senderAddress = warehouse === null ? null : asRecord(warehouse.address)
  const sender = senderAddress === null ? null : carrierAddress(senderAddress)
  if (warehouse === null || senderAddress === null || sender === null) {
    throw shippingRefusal(
      ErrorCodes.SHIPPING_ORIGIN_MISSING,
      'the origin warehouse has no address or is not linked to the store'
    )
  }

  // What the order already has: a guide whose outcome is unknown stops a new one, and so does any active one
  const existing = await tx.shipment.findMany({
    where: {
      orderId: order.id,
      storeId,
      kind: ShipmentKind.OUTBOUND,
      status: { notIn: [...ShipmentInactiveStatuses] }
    },
    select: { originWarehouseId: true, codAmountCents: true, status: true }
  })
  const same = existing.find(entry => entry.originWarehouseId === warehouse.id)
  if (same !== undefined) {
    const unknown = ShipmentUnknownOutcomeStatuses.some(status => String(status) === same.status)
    throw shippingRefusal(
      unknown ? ErrorCodes.SHIPPING_OUTCOME_UNKNOWN : ErrorCodes.SHIPPING_ACTIVE_SHIPMENT_EXISTS,
      unknown
        ? 'a guide of the order may exist at the carrier'
        : 'the order already has an active guide'
    )
  }
  const attempt =
    (await tx.shipment.count({
      where: {
        orderId: order.id,
        storeId,
        kind: ShipmentKind.OUTBOUND,
        originWarehouseId: warehouse.id
      }
    })) + 1
  const idempotencyKey = shipmentIdempotencyKey(order.id, warehouse.id, attempt)

  const codAmountCents = codAmountFor({
    order: {
      totalCents: order.totalCents,
      subtotalCents: order.subtotalCents,
      discountCents: order.discountCents,
      shippingCents: order.shippingCents,
      collectsOnDelivery: collects
    },
    origins,
    originWarehouseId: warehouse.id,
    others: existing.map(entry => ({
      originWarehouseId: entry.originWarehouseId,
      codAmountCents: entry.codAmountCents
    }))
  })
  const shippingPayer =
    request.shippingPayer ??
    (order.freeShipping ? ShippingPayer.SENDER : (connection.defaultShippingPayer as ShippingPayer))
  // What the customer wrote is bounded and one line like what the agent types (the schema does that for `request.notes`)
  const written =
    request.notes ??
    (order.customerNotes === null
      ? undefined
      : clampCarrierMessage(order.customerNotes).slice(0, ShipmentLimits.NOTES_MAX_LENGTH))
  const notes = written

  const contact = asRecord(connection.contact)
  const senderPhone = typeof contact?.['phone'] === 'string' ? contact['phone'] : undefined
  const recipientName = order.customer.name?.trim() || order.orderNumber
  // Only an address that is one goes to the carrier: what the store keeps there may be a placeholder of an import
  const isEmail = (value: string | null): value is string =>
    value !== null && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
  const labelFormat = connection.labelFormat as LabelFormatType

  const params: CreateShipmentParams = {
    reference: order.orderNumber,
    idempotencyKey,
    sender: { name: warehouse.name, address: sender, phone: senderPhone ?? '' },
    recipient: {
      name: recipientName,
      phones: order.recipientPhones,
      ...(isEmail(order.customer.email) ? { email: order.customer.email.trim() } : {}),
      address: recipientAddress,
      ...(request.locationIds === undefined ? {} : { locationIds: request.locationIds })
    },
    packageCount: 1,
    parcels: [{}],
    serviceCode: service.code,
    shippingPayer,
    cod: codAmountCents === null ? null : { amountCents: codAmountCents, currency: order.currency },
    labelFormat,
    ...(notes === undefined || notes === '' ? {} : { notes })
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
      kind: ShipmentKind.OUTBOUND,
      originWarehouseId: warehouse.id,
      serviceCode: service.code,
      shippingPayer,
      codAmountCents,
      codStatus: codAmountCents === null ? CodStatus.NOT_APPLICABLE : CodStatus.NOT_DELIVERED,
      currency: order.currency,
      packageCount: 1,
      carrierRateCents: rateCentsOf(
        connection.serviceRatesCents,
        rateServiceOf(plugin, {
          shippingPayer,
          cod: codAmountCents !== null,
          serviceCode: service.code
        })
      ),
      commissionBps: connection.commissionBps,
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
      senderName: warehouse.name,
      senderPhone,
      senderLines: addressLines(senderAddress),
      recipientName,
      recipientLines: addressLines(destination),
      recipientPhones: order.recipientPhones,
      serviceLabel: service.label,
      notes: notes === '' ? undefined : notes,
      codAmountCents,
      currency: order.currency
    }
  }
}
