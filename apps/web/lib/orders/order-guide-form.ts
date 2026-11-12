import {
  CarrierCapability,
  CarrierConnectionStatus,
  CLOCK_TIME_PATTERN,
  type CreateShipmentBody,
  type CreateReturnShipmentBody,
  PaymentMethod,
  PaymentStatus,
  ShippingPayer
} from '@platform/core/domain'

// The form that makes the guide of an order (TDD_17 §4.5) and the one that makes the guide of the way back of a return (§4.11).
// What a connection offers comes from its capabilities and its settings, never from the name of a carrier.

export interface GuideConnection {
  id: string
  displayName: string
  status: string
  isDefault: boolean
  capabilities: readonly string[]
  defaultServiceCode: string | null
  defaultShippingPayer: string
  services: readonly { code: string; label: string; active: boolean }[]
}

const ACTIVE: string = CarrierConnectionStatus.ACTIVE
const RECIPIENT: string = ShippingPayer.RECIPIENT
const CASH_ON_DELIVERY: string = PaymentMethod.CASH_ON_DELIVERY
const PAID: string = PaymentStatus.COMPLETED

const MAKES_GUIDES: readonly string[] = [
  CarrierCapability.CREATE_SHIPMENT,
  CarrierCapability.PICKUP_BOUND_GUIDES,
  CarrierCapability.INTERNAL_GUIDE
]

const has = (connection: GuideConnection, capability: string): boolean =>
  connection.capabilities.includes(capability)

// The connections that can make an outbound guide from this screen: live, able to create one, and not one that asks for the
// carrier's own ids of the places (the selectors for those come with the location lookup of the carrier adapters, Step 4.15)
export function guideConnections(connections: readonly GuideConnection[]): GuideConnection[] {
  return connections.filter(
    connection =>
      connection.status === ACTIVE &&
      connection.capabilities.some(capability => MAKES_GUIDES.includes(capability)) &&
      !has(connection, CarrierCapability.REQUIRES_LOCATION_IDS)
  )
}

// How many live connections can make a guide but need the ids of the places: the dialog says they are not offered
export function connectionsNeedingLocations(connections: readonly GuideConnection[]): number {
  return connections.filter(
    connection =>
      connection.status === ACTIVE &&
      connection.capabilities.some(capability => MAKES_GUIDES.includes(capability)) &&
      has(connection, CarrierCapability.REQUIRES_LOCATION_IDS)
  ).length
}

// The connections that can make the guide of the way back
export function returnGuideConnections(connections: readonly GuideConnection[]): GuideConnection[] {
  return connections.filter(
    connection =>
      connection.status === ACTIVE &&
      has(connection, CarrierCapability.RETURN_SHIPMENT) &&
      !has(connection, CarrierCapability.REQUIRES_LOCATION_IDS)
  )
}

// The one the store marked as default when it can be used, else the first
export function defaultConnection(
  connections: readonly GuideConnection[]
): GuideConnection | undefined {
  return connections.find(connection => connection.isDefault) ?? connections[0]
}

export const activeServices = (connection: GuideConnection): GuideConnection['services'] =>
  connection.services.filter(service => service.active)

// The service the connection starts with: its default when it is live, else the first live one, else none (the api picks)
export function initialService(connection: GuideConnection): string {
  const live = activeServices(connection)
  const preferred = live.find(service => service.code === connection.defaultServiceCode)
  return (preferred ?? live[0])?.code ?? ''
}

// A free-shipping order is paid by the sender; any other starts with the connection's own payer
export function initialPayer(connection: GuideConnection, freeShipping: boolean): ShippingPayer {
  if (freeShipping) return ShippingPayer.SENDER
  return connection.defaultShippingPayer === RECIPIENT
    ? ShippingPayer.RECIPIENT
    : ShippingPayer.SENDER
}

// A carrier whose guides exist only inside a pickup request is told the day and window of the pickup
export const needsPickup = (connection: GuideConnection): boolean =>
  has(connection, CarrierCapability.PICKUP_BOUND_GUIDES)

// What the carrier collects, for the screen (it is read-only: the amount is the order's and the api writes it). A prepaid order, or
// one paid by cash on delivery that is already paid, collects nothing.
export function codPreview(order: {
  paymentMethod: string
  paymentStatus: string
  totalCents: number
}): { collects: boolean; amountCents: number } {
  const collects = order.paymentMethod === CASH_ON_DELIVERY && order.paymentStatus !== PAID
  return { collects, amountCents: collects ? order.totalCents : 0 }
}

export interface GuideDraft {
  connectionId: string
  serviceCode: string
  payer: ShippingPayer
  notes: string
  pickupDate: string
  pickupFrom: string
  pickupTo: string
}

export function initialDraft(
  connection: GuideConnection | undefined,
  freeShipping: boolean
): GuideDraft {
  return {
    connectionId: connection?.id ?? '',
    serviceCode: connection === undefined ? '' : initialService(connection),
    payer:
      connection === undefined
        ? freeShipping
          ? ShippingPayer.SENDER
          : ShippingPayer.RECIPIENT
        : initialPayer(connection, freeShipping),
    notes: '',
    pickupDate: '',
    pickupFrom: '',
    pickupTo: ''
  }
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

// The pickup is all or nothing: a day and both ends of the window, the window ending after it starts. Without it the connection's
// next valid day is used. Null for a window that is half written or backwards.
export function pickupOf(
  draft: Pick<GuideDraft, 'pickupDate' | 'pickupFrom' | 'pickupTo'>
): { date: string; from: string; to: string } | null | undefined {
  const empty = draft.pickupDate === '' && draft.pickupFrom === '' && draft.pickupTo === ''
  if (empty) return undefined
  const ok =
    ISO_DAY.test(draft.pickupDate) &&
    CLOCK_TIME_PATTERN.test(draft.pickupFrom) &&
    CLOCK_TIME_PATTERN.test(draft.pickupTo) &&
    draft.pickupFrom < draft.pickupTo
  return ok ? { date: draft.pickupDate, from: draft.pickupFrom, to: draft.pickupTo } : null
}

// The body of the guide, or null while the form is not ready. The service is sent only when one was chosen; the payer is always sent
// (what the screen showed is what is made); the pickup only for a carrier that takes one.
export function guideBody(
  draft: GuideDraft,
  connection: GuideConnection | undefined,
  freeShipping: boolean
): CreateShipmentBody | null {
  if (connection === undefined) return null
  const pickup = needsPickup(connection) ? pickupOf(draft) : undefined
  if (pickup === null) return null
  const notes = draft.notes.trim()
  return {
    connectionId: connection.id,
    ...(draft.serviceCode === '' ? {} : { serviceCode: draft.serviceCode }),
    // A free-shipping order is paid by the sender whatever the draft holds
    shippingPayer: freeShipping ? ShippingPayer.SENDER : draft.payer,
    ...(notes === '' ? {} : { notes }),
    ...(pickup === undefined ? {} : { pickup })
  }
}

// The guide of the way back: the connection, the service when one was chosen, and the warehouse the goods go to when the agent chose one. The payer is
// the return's and the guide is never cash on delivery, so neither is asked.
export function returnGuideBody(input: {
  connectionId: string
  serviceCode: string
  warehouseId: string
  notes: string
}): CreateReturnShipmentBody | null {
  if (input.connectionId === '') return null
  const notes = input.notes.trim()
  return {
    connectionId: input.connectionId,
    ...(input.serviceCode === '' ? {} : { serviceCode: input.serviceCode }),
    ...(input.warehouseId === '' ? {} : { warehouseId: input.warehouseId }),
    ...(notes === '' ? {} : { notes })
  }
}
