import type { OrderTemplateView } from '@platform/api-client'
import {
  DeliveryStatus,
  OrderMessageKind,
  type OrderMessageKindType,
  type OrderMessageNotSentReason,
  OrderMessageNotSentReasons,
  type OrderMessageRoute,
  OrderMessageRoutes,
  type OrderStatus,
  OrderStatusMessageKinds
} from '@platform/core/domain'

// What the Messages panel of the order detail offers and how it reads what the api answers (TDD_17 §4.7). Pure: the panel only draws.

// The kinds a person sends by hand from here. The two that are about a package of the way back or of a replacement need to name that
// package, which the Returns screens do (Step 4.14, F7a), so they are not offered here.
export const MANUAL_MESSAGE_KINDS: readonly OrderMessageKindType[] = Object.values(
  OrderMessageKind
).filter(
  kind => kind !== OrderMessageKind.RETURN_APPROVED && kind !== OrderMessageKind.EXCHANGE_SHIPPED
)

const KNOWN_REASONS: readonly string[] = Object.values(OrderMessageNotSentReasons)
const KNOWN_ROUTES: readonly string[] = Object.values(OrderMessageRoutes)
const KNOWN_KINDS: readonly string[] = Object.values(OrderMessageKind)
const KNOWN_DELIVERIES: readonly string[] = Object.values(DeliveryStatus)

// A value the api sends that this page does not know (a newer server) is drawn with a generic line, never with the raw code
export const knownKind = (value: string): OrderMessageKindType | null =>
  KNOWN_KINDS.includes(value) ? (value as OrderMessageKindType) : null
export const knownReason = (value: string): OrderMessageNotSentReason | null =>
  KNOWN_REASONS.includes(value) ? (value as OrderMessageNotSentReason) : null
export const knownDelivery = (value: string): DeliveryStatus | null =>
  KNOWN_DELIVERIES.includes(value) ? (value as DeliveryStatus) : null
export const knownRoute = (value: string): OrderMessageRoute | null =>
  KNOWN_ROUTES.includes(value) ? (value as OrderMessageRoute) : null

// The kind a status that a person sets by hand tells the customer about; undefined for a status the customer is not told about
export const messageKindOfStatus = (
  status: OrderStatus | undefined
): OrderMessageKindType | undefined =>
  status === undefined ? undefined : OrderStatusMessageKinds[status]

// The "Notify the customer" box of a status change starts from the `autoSend` of the template of its kind. The api picks the
// template of the customer's language, then the store's; here any template of the kind that goes by itself turns the box on.
// With no template the box starts off.
export function notifyStartsOn(
  templates: readonly Pick<OrderTemplateView, 'kind' | 'autoSend'>[] | undefined,
  kind: OrderMessageKindType
): boolean {
  return templates?.some(template => template.kind === kind && template.autoSend) ?? false
}
