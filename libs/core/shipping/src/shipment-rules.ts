import {
  CarrierCapability,
  type CarrierCapabilityType,
  CarrierFeeLimits,
  OrderStatus,
  PriceApprovalStatus,
  ShipmentFailureReasons,
  ShipmentLimits,
  type ShipmentStatus,
  ShipmentStatusTransitions
} from '@platform/core/domain'
import { ErrorCodes, type ErrorCode } from '@platform/core/errors'
import {
  CarrierAuthError,
  CarrierRejectedError,
  CarrierUnavailableError,
  type CarrierPlugin,
  type CarrierRateGuide,
  type ShipmentCreationMode,
  ShipmentCreationModes
} from '@platform/plugins/sdk'

import { CarrierCredentialsUnreadableError } from './carrier-context'

// The pure rules of the shipment engine (TDD_17 §4.4, §4.5, §4.8, §4.13): what the service decides, kept apart from the
// database so that each one is proven by a test that needs none.

// ---------------------------------------------------------------- the state machine

// Forward only (TDD_17 §3): the table says from where a status may go. The same status is allowed only where the table
// lists it (a repeated failed attempt).
export function isShipmentTransitionAllowed(from: ShipmentStatus, to: ShipmentStatus): boolean {
  return ShipmentStatusTransitions[from].includes(to)
}

// ---------------------------------------------------------------- what an order needs to be shipped

export interface ShippableOrder {
  status: string
  priceApprovalStatus: string
  shippingAddress: unknown
  recipientPhones: readonly string[]
}

const SHIPPABLE_ORDER_STATUSES: readonly string[] = [OrderStatus.CONFIRMED, OrderStatus.PREPARING]
const BLOCKING_APPROVALS: readonly string[] = [
  PriceApprovalStatus.PENDING,
  PriceApprovalStatus.REJECTED
]

// The first thing that keeps an order from getting a guide, or null (TDD_17 §4.5 step 1, §4.13)
export function orderBlockOf(order: ShippableOrder): ErrorCode | null {
  if (!SHIPPABLE_ORDER_STATUSES.includes(order.status))
    return ErrorCodes.SHIPPING_ORDER_NOT_CONFIRMED
  if (BLOCKING_APPROVALS.includes(order.priceApprovalStatus)) {
    return ErrorCodes.ORDER_PRICE_APPROVAL_PENDING
  }
  if (typeof order.shippingAddress !== 'object' || order.shippingAddress === null) {
    return ErrorCodes.SHIPPING_ADDRESS_MISSING
  }
  if (order.recipientPhones.length === 0) return ErrorCodes.SHIPPING_RECIPIENT_PHONE_MISSING
  return null
}

// What the creation mode of a plugin needs it to be able to do (TDD_17 §4.5 step 1), or null when it can
export function creationCapabilityOf(mode: ShipmentCreationMode): CarrierCapabilityType {
  if (mode === ShipmentCreationModes.INTERNAL) return CarrierCapability.INTERNAL_GUIDE
  return mode === ShipmentCreationModes.PICKUP_BOUND
    ? CarrierCapability.PICKUP_BOUND_GUIDES
    : CarrierCapability.CREATE_SHIPMENT
}

// ---------------------------------------------------------------- the fee at guide time (TDD_17 §4.13)

export interface GuideFeeInput {
  feeCents: number
  freeShipping: boolean
  // Is the fee inside the range of the connection that will carry it
  withinRange: boolean
  // What an approver accepted, when the order holds an approval
  approvedShippingCents: number | null
  approvalStatus: string
  canOverridePrice: boolean
}

// A guide is refused for a fee the connection's range does not accept, unless the order is free-shipping with fee 0, the
// fee is the one an approver accepted, or the caller may override prices. `withinRange` already counts the free-shipping
// case, so it is the one place that rule lives (`isShippingFeeWithinRange`).
export function isFeeAcceptedForGuide(input: GuideFeeInput): boolean {
  if (input.withinRange) return true
  if (input.canOverridePrice) return true
  return (
    input.approvalStatus === String(PriceApprovalStatus.APPROVED) &&
    input.approvedShippingCents !== null &&
    input.approvedShippingCents === input.feeCents
  )
}

// ---------------------------------------------------------------- the amount to collect (TDD_17 §4.4)

export interface CodOrder {
  totalCents: number
  subtotalCents: number
  discountCents: number
  shippingCents: number
  // Cash on delivery and not paid yet
  collectsOnDelivery: boolean
}

export interface CodWarehouseValue {
  warehouseId: string | null
  // The value of the lines this warehouse sends, at the price they were sold at
  linesCents: number
}

export interface CodInput {
  order: CodOrder
  // Every origin the order's lines leave from, with the value of its lines
  origins: readonly CodWarehouseValue[]
  // The origin of the guide being made
  originWarehouseId: string | null
  // What the other active outbound guides of the order already collect, by origin
  others: readonly { originWarehouseId: string | null; codAmountCents: number | null }[]
}

// The amount a guide collects, or null for a prepaid order. One origin carries the whole total. With several, each guide
// carries the value of its own lines less its proportional share of the discount; the fee goes on the first guide made, and
// the last one absorbs the rounding, so the amounts add up to the total exactly (a guide cancelled and made again keeps its
// share: it is the one left, and gets what the others leave of the total).
export function codAmountFor(input: CodInput): number | null {
  const { order, origins, originWarehouseId, others } = input
  if (!order.collectsOnDelivery) return null
  // One origin carries the whole total, less what the guides of other origins already collect (an order allocated again after a
  // guide was made from another warehouse): the customer pays the total once
  if (origins.length <= 1) {
    const taken = others
      .filter(other => other.originWarehouseId !== originWarehouseId)
      .reduce((sum, other) => sum + (other.codAmountCents ?? 0), 0)
    return Math.max(0, order.totalCents - taken)
  }
  const covered = new Set(others.map(other => other.originWarehouseId))
  const uncovered = origins.filter(origin => !covered.has(origin.warehouseId))
  const mine = origins.find(origin => origin.warehouseId === originWarehouseId)
  if (mine === undefined) return order.totalCents
  // The last one: what the others do not collect
  if (uncovered.length <= 1) {
    const taken = others.reduce((sum, other) => sum + (other.codAmountCents ?? 0), 0)
    return Math.max(0, order.totalCents - taken)
  }
  const discountShare =
    order.subtotalCents === 0
      ? 0
      : Math.floor((order.discountCents * mine.linesCents) / order.subtotalCents)
  const fee = others.length === 0 ? order.shippingCents : 0
  return Math.max(0, mine.linesCents - discountShare + fee)
}

// ---------------------------------------------------------------- what a carrier answers

export const CarrierCallOutcomes = {
  // The carrier refused: nothing was made
  REJECTED: 'rejected',
  // The credentials were refused: nothing was made, and the connection needs attention
  AUTH: 'auth',
  // The credentials could not be opened here: nothing was sent
  UNREADABLE: 'unreadable',
  // Anything else, timeouts first: a guide may exist
  UNKNOWN: 'unknown'
} as const
export type CarrierCallOutcome = (typeof CarrierCallOutcomes)[keyof typeof CarrierCallOutcomes]

// What a failed call means for the shipment (TDD_17 §4.1, §4.5). Only an answer that says nothing was made is "failed": an
// error the platform cannot read, a bug in the plugin, a timeout or a lost connection all mean that a guide may exist.
export function classifyCarrierError(error: unknown): CarrierCallOutcome {
  if (error instanceof CarrierRejectedError) return CarrierCallOutcomes.REJECTED
  if (error instanceof CarrierAuthError) return CarrierCallOutcomes.AUTH
  if (error instanceof CarrierCredentialsUnreadableError) return CarrierCallOutcomes.UNREADABLE
  return CarrierCallOutcomes.UNKNOWN
}

// Only an unavailable carrier is asked again, and only one that promised the same key never makes a second guide
export function mayRetryCreate(error: unknown, idempotent: boolean): boolean {
  return idempotent && error instanceof CarrierUnavailableError
}

// A void that is asked again (TDD_17 §4.8): the carrier did not answer, or answered something the platform cannot read. The key of
// a void is the same each time, so asking twice is safe. A refusal, rejected credentials or credentials that do not open do not
// change by waiting: those end the void at once.
export function mayRetryVoid(error: unknown): boolean {
  return classifyCarrierError(error) === CarrierCallOutcomes.UNKNOWN
}

// What a carrier said, kept as one bounded line (TDD_17 §4.5 step 5). A carrier's words are the carrier's: they are shown to
// the agent and never trusted as markup, and a control character or a very long text is cut here.
export function clampCarrierMessage(message: string): string {
  // A control character becomes a space, then the spaces collapse: one line, whatever the carrier sent
  const printable = Array.from(message, char => (hasControlCharacter(char) ? ' ' : char)).join('')
  return printable.replace(/\s+/g, ' ').trim().slice(0, ShipmentLimits.LAST_ERROR_MAX_LENGTH)
}

// A character below the space, or DEL: what a text shown on one line must not carry
function hasControlCharacter(text: string): boolean {
  return Array.from(text).some(char => {
    const code = char.codePointAt(0) ?? 0
    return code < 0x20 || code === 0x7f
  })
}

export function failureReasonOf(outcome: CarrierCallOutcome): string {
  switch (outcome) {
    case CarrierCallOutcomes.AUTH:
      return ShipmentFailureReasons.AUTH
    case CarrierCallOutcomes.UNREADABLE:
      return ShipmentFailureReasons.CREDENTIALS_UNREADABLE
    default:
      return ShipmentFailureReasons.UNKNOWN_OUTCOME
  }
}

// A guide as the carrier gave it: a non-empty single line of a sane length (what is printed, scanned and found again)
export function isUsableGuideNumber(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= ShipmentLimits.GUIDE_NUMBER_MAX_LENGTH &&
    !hasControlCharacter(value)
  )
}

// ---------------------------------------------------------------- pickups

export interface PickupRules {
  pickupDays: readonly number[]
  // 'HH:mm' in the timezone of the store
  pickupCutoffTime: string | null
}

// The wall clock of an instant in a timezone: its ISO weekday (1 = Monday), its date and its 'HH:mm'
export function wallClockOf(
  instant: Date,
  timeZone: string
): { weekday: number; date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short'
  }).formatToParts(instant)
  const part = (type: string): string => parts.find(entry => entry.type === type)?.value ?? ''
  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  return {
    weekday: weekdays.indexOf(part('weekday')) + 1,
    date: `${part('year')}-${part('month')}-${part('day')}`,
    time: `${part('hour')}:${part('minute')}`
  }
}

const DAY_MS = 24 * 60 * 60 * 1000

// The next day a carrier comes (TDD_17 §4.5): a day in `pickupDays` whose cutoff has not passed, otherwise the next one.
// null when the connection has no day at all.
export function nextPickupDate(now: Date, timeZone: string, rules: PickupRules): string | null {
  if (rules.pickupDays.length === 0) return null
  const today = wallClockOf(now, timeZone)
  const cutoffPassed = rules.pickupCutoffTime !== null && today.time > rules.pickupCutoffTime
  // A week and a day always holds a valid one when there is any
  for (let offset = 0; offset <= 7; offset += 1) {
    if (offset === 0 && cutoffPassed) continue
    const candidate = wallClockOf(new Date(now.getTime() + offset * DAY_MS), timeZone)
    if (rules.pickupDays.includes(candidate.weekday)) return candidate.date
  }
  return null
}

// ---------------------------------------------------------------- the rate of a guide (TDD_17 §4.15)

// The rate service the carrier says a guide falls under, or null: a plugin that declares none, throws, or answers with something
// that is not a code is a guide with no rate, never a refused one. The plugin is third-party code and the guide is made anyway.
export function rateServiceOf(
  plugin: Pick<CarrierPlugin, 'feeSettings'>,
  guide: CarrierRateGuide
): string | null {
  try {
    const settings = plugin.feeSettings
    if (settings === undefined) return null
    const code: unknown = settings.rateServiceOf(guide)
    return typeof code === 'string' && CarrierFeeLimits.RATE_CODE_PATTERN.test(code) ? code : null
  } catch {
    return null
  }
}
