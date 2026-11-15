import { isWebhookEvent } from '@platform/core/domain'
import { Events } from '@platform/core/events'

import { type PluginScope, PluginScopes } from './plugin-scopes'

// The scope an installation needs to be told of an event (TDD_10 §6.5). An event that is not here is never sent to a plugin: the
// returns have no scope of their own yet (the PR that exposes their routes adds `returns:read` and these three lines), and the
// events nobody may follow (the webhook catalog is the only list a plugin chooses from) have no listener at all.
export const PluginEventScopes: Readonly<Record<string, PluginScope>> = {
  [Events.ORDER_CREATED]: PluginScopes.ORDERS_READ,
  [Events.ORDER_UPDATED]: PluginScopes.ORDERS_READ,
  [Events.ORDER_CONFIRMED]: PluginScopes.ORDERS_READ,
  [Events.ORDER_STATUS_CHANGED]: PluginScopes.ORDERS_READ,
  [Events.ORDER_SHIPPED]: PluginScopes.ORDERS_READ,
  [Events.ORDER_DELIVERED]: PluginScopes.ORDERS_READ,
  [Events.ORDER_CANCELLED]: PluginScopes.ORDERS_READ,
  [Events.ORDER_PAYMENT_RECORDED]: PluginScopes.ORDERS_READ,
  [Events.ORDER_PAYMENT_STATUS_CHANGED]: PluginScopes.ORDERS_READ,
  [Events.CUSTOMER_CREATED]: PluginScopes.CUSTOMERS_READ,
  [Events.CUSTOMER_UPDATED]: PluginScopes.CUSTOMERS_READ,
  [Events.CUSTOMER_MERGED]: PluginScopes.CUSTOMERS_READ,
  [Events.CONVERSATION_CREATED]: PluginScopes.CONVERSATIONS_READ,
  [Events.CONVERSATION_STATUS_CHANGED]: PluginScopes.CONVERSATIONS_READ,
  [Events.CONVERSATION_ASSIGNED]: PluginScopes.CONVERSATIONS_READ,
  [Events.MESSAGE_RECEIVED]: PluginScopes.MESSAGES_READ,
  [Events.MESSAGE_SENT]: PluginScopes.MESSAGES_READ,
  [Events.SHIPMENT_CREATED]: PluginScopes.SHIPMENTS_READ,
  [Events.SHIPMENT_STATUS_CHANGED]: PluginScopes.SHIPMENTS_READ,
  [Events.SHIPMENT_CANCELLED]: PluginScopes.SHIPMENTS_READ,
  [Events.PRODUCT_CREATED]: PluginScopes.PRODUCTS_READ,
  [Events.PRODUCT_UPDATED]: PluginScopes.PRODUCTS_READ,
  [Events.PRODUCT_DELETED]: PluginScopes.PRODUCTS_READ
}

// What an installation is told of an event, field by field. A field is sent only when it is named here: a key a payload gains
// tomorrow is held back until somebody decides which scope opens it. `null` is for what every plugin may know of an event it
// is told of (the store is its own, and a status or an amount is not a person); a list is the scopes of which the installation
// needs one, because the id of a resource is what its routes take. What is not here never leaves for a plugin: the ids of the
// people of the team (`assignedTo`, `actor`, `changedBy`, `visibility`: the team directory has no scope), the text of a message,
// and the flags that steer what the platform itself does (`notifyCustomer`, `sendSummary`, `replay`).
const FIELD_SCOPES: Readonly<Record<string, readonly PluginScope[] | null>> = {
  storeId: null,
  status: null,
  previousStatus: null,
  from: null,
  to: null,
  receivedAt: null,
  channelType: null,
  authorType: null,
  totalCents: null,
  currency: null,
  conversationId: [PluginScopes.CONVERSATIONS_READ, PluginScopes.MESSAGES_READ],
  messageId: [PluginScopes.MESSAGES_READ],
  // A customer's id is the way to their contact details: a plugin that did not ask for customers never gets it
  customerId: [PluginScopes.CUSTOMERS_READ],
  survivorId: [PluginScopes.CUSTOMERS_READ],
  absorbedId: [PluginScopes.CUSTOMERS_READ],
  orderId: [PluginScopes.ORDERS_READ, PluginScopes.SHIPMENTS_READ],
  orderNumber: [PluginScopes.ORDERS_READ, PluginScopes.SHIPMENTS_READ],
  returnId: [PluginScopes.ORDERS_READ],
  shipmentId: [PluginScopes.SHIPMENTS_READ],
  connectionId: [PluginScopes.SHIPMENTS_READ],
  productId: [PluginScopes.PRODUCTS_READ]
}

export type PluginWebhookData = Record<string, string | number | boolean | null>

// What goes to a plugin of an event: null when the installation is not to be told of it at all (the event is not one a plugin
// follows, or its scope was not granted), else the fields its scopes open. A value that is not a plain one (an object, a list)
// is never sent.
export function redactForScopes(
  event: string,
  payload: Readonly<Record<string, unknown>>,
  granted: readonly string[]
): PluginWebhookData | null {
  if (!isWebhookEvent(event)) return null
  const needed = PluginEventScopes[event]
  if (needed === undefined || !granted.includes(needed)) return null
  const data: PluginWebhookData = {}
  for (const [key, value] of Object.entries(payload)) {
    if (!Object.hasOwn(FIELD_SCOPES, key)) continue
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      continue
    }
    const scopes = FIELD_SCOPES[key]
    if (scopes === undefined) continue
    if (scopes === null || scopes.some(scope => granted.includes(scope))) data[key] = value
  }
  return data
}
