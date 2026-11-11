import {
  type OrderMessageKindType,
  type OrderMessageNotSentReason,
  OrderMessageNotSentReasons,
  OrderMessageRoutes
} from '@platform/core/domain'

// What the core knows about the channel of the conversation, taken from what its plugin DECLARES (`messagingWindow`, the
// `TEMPLATES` capability) and from the conversation, never from the plugin's name (CLAUDE.md rule 13).
export interface OrderMessageChannel {
  // The plugin declares a window (`messagingWindow` is not null): without one, free text goes at any time
  hasWindow: boolean
  // The window is open now (always true when there is none)
  windowOpen: boolean
  // The plugin declares `TEMPLATES` and a window that asks for a template when closed
  takesTemplates: boolean
  // The channel-approved template linked to the order template: none, one the channel lists as approved with matching
  // placeholders (`usable`), or one that is linked but fails that check (`unusable`)
  template: 'none' | 'usable' | 'unusable'
}

export interface OrderMessageRouteInput {
  // null when the order has no conversation and the customer has no open one
  channel: OrderMessageChannel | null
  hasEmail: boolean
}

export type OrderMessageRouteDecision =
  | {
      route: typeof OrderMessageRoutes.CHANNEL_TEXT | typeof OrderMessageRoutes.CHANNEL_TEMPLATE
    }
  | { route: typeof OrderMessageRoutes.EMAIL }
  | { route: typeof OrderMessageRoutes.NOT_SENT; reason: OrderMessageNotSentReason }

// The messaging-window decision of TDD_17 §4.7, as data in and a route out: free text always for a channel that declares no
// window, free text inside it, the approved template outside it, otherwise email when the customer has an address, otherwise
// not sent with the reason. A message is never dropped silently: every path ends in a route or a reason.
export function decideOrderMessageRoute(input: OrderMessageRouteInput): OrderMessageRouteDecision {
  const { channel, hasEmail } = input
  if (channel === null) {
    return hasEmail
      ? { route: OrderMessageRoutes.EMAIL }
      : { route: OrderMessageRoutes.NOT_SENT, reason: OrderMessageNotSentReasons.NO_CHANNEL }
  }
  if (!channel.hasWindow || channel.windowOpen) return { route: OrderMessageRoutes.CHANNEL_TEXT }
  if (channel.takesTemplates && channel.template === 'usable') {
    return { route: OrderMessageRoutes.CHANNEL_TEMPLATE }
  }
  if (hasEmail) return { route: OrderMessageRoutes.EMAIL }
  return {
    route: OrderMessageRoutes.NOT_SENT,
    reason:
      channel.takesTemplates && channel.template === 'unusable'
        ? OrderMessageNotSentReasons.TEMPLATE_UNAVAILABLE
        : OrderMessageNotSentReasons.WINDOW_CLOSED
  }
}

// One automatic message per `(shipmentId, status, kind)` (TDD_17 §4.7): a carrier that repeats an event sends nothing twice.
// A failed attempt is a status that can happen three times on one shipment, so its number is part of the key.
export function automaticDispatchKey(
  shipmentId: string,
  status: string,
  kind: OrderMessageKindType,
  attemptNumber?: number
): string {
  const base = `auto:${shipmentId}:${status}:${kind}`
  return attemptNumber === undefined ? base : `${base}:${attemptNumber}`
}

// A manual status change keys by `(orderId, kind, status)`: marking the same order delivered twice tells the customer once
export function manualDispatchKey(
  orderId: string,
  kind: OrderMessageKindType,
  status: string
): string {
  return `manual:${orderId}:${kind}:${status}`
}

// A person pressing "send" (or "send again") sends every time: the key is the one their client made for that press, so a
// retried request or a double click sends once and a second press, another message
export function pressedDispatchKey(
  orderId: string,
  kind: OrderMessageKindType,
  clientKey: string
): string {
  return `pressed:${orderId}:${kind}:${clientKey}`
}
