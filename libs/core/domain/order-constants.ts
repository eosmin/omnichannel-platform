import { Permissions, type Permission } from './auth/permissions'
import { OrderStatus } from './status-enums'

export const OrderMessageKind = {
  ORDER_SUMMARY: 'order_summary',
  ORDER_SHIPPED: 'order_shipped',
  ORDER_OUT_FOR_DELIVERY: 'order_out_for_delivery',
  ORDER_DELIVERED: 'order_delivered',
  ORDER_FAILED_ATTEMPT: 'order_failed_attempt',
  ORDER_CANCELLED: 'order_cancelled',
  RETURN_APPROVED: 'return_approved',
  EXCHANGE_SHIPPED: 'exchange_shipped'
} as const
export type OrderMessageKindType = (typeof OrderMessageKind)[keyof typeof OrderMessageKind]

// The only placeholders an order message template may use (TDD_17 §4.7).
export const OrderMessageVariables = {
  CUSTOMER_NAME: 'customerName',
  ORDER_NUMBER: 'orderNumber',
  ITEMS_LIST: 'itemsList',
  TOTAL: 'total',
  SHIPPING_ADDRESS: 'shippingAddress',
  CARRIER_NAME: 'carrierName',
  TRACKING_NUMBER: 'trackingNumber',
  TRACKING_URL: 'trackingUrl',
  STORE_NAME: 'storeName',
  COD_AMOUNT: 'codAmount',
  ATTEMPT_NUMBER: 'attemptNumber', // The shipment's failedAttempts (TDD_17 §4.7)
  MAX_ATTEMPTS: 'maxAttempts', // The connection's maxDeliveryAttempts
  SCHEDULED_DELIVERY_DATE: 'scheduledDeliveryDate' // The order's day; an order without one blocks the send (TDD_17 §4.7)
} as const
export type OrderMessageVariable =
  (typeof OrderMessageVariables)[keyof typeof OrderMessageVariables]

// Why a message that was due did not go (TDD_17 §4.7). The timeline of the order shows it and the team is told
// (`order.message_not_sent`): a message is never dropped silently.
export const OrderMessageNotSentReasons = {
  // The template uses a variable the order has no value for ("your order arrives on ."): the send is refused, it does not
  // fall back to email because the email would carry the same hole
  MISSING_VARIABLE: 'missing_variable',
  // The message, filled in, is longer than a channel takes (a long list of items): sending it would be refused or cut
  TOO_LONG: 'too_long',
  // The store has no template of this kind, neither in the customer's language nor in its own
  NO_TEMPLATE: 'no_template',
  // The order has no conversation, the customer has no open one and no email to fall back to
  NO_CHANNEL: 'no_channel',
  // The window of the channel is closed, no approved template is linked and the customer has no email
  WINDOW_CLOSED: 'window_closed',
  // A template is linked but the channel does not list it as approved, its placeholders do not match, or its plugin
  // changed since it was linked; with no email to fall back to
  TEMPLATE_UNAVAILABLE: 'template_unavailable',
  // The customer was erased (`TDD_05 §10`): nothing is written to who asked to be forgotten
  CUSTOMER_ERASED: 'customer_erased',
  // The customer withdrew their consent to order messages (a `ConsentRecord` of purpose `order_messages`, granted false)
  CONSENT_REVOKED: 'consent_revoked'
} as const
export type OrderMessageNotSentReason =
  (typeof OrderMessageNotSentReasons)[keyof typeof OrderMessageNotSentReasons]

// The reason of a message that could not be sent for a cause that may pass (the provider did not answer) and kept failing after the
// retries of the listener. It is never recorded: nothing is claimed, so a later event of the same shipment sends the message, and the
// team is told meanwhile (`order.message_not_sent`)
export const OrderMessageSendFailed = 'send_failed'
export type OrderMessageAlertReason = OrderMessageNotSentReason | typeof OrderMessageSendFailed

// Where a message went (TDD_17 §4.7): the two ways through the conversation's channel (what its plugin declares decides
// which), the email fallback, or nowhere (with its reason)
export const OrderMessageRoutes = {
  CHANNEL_TEXT: 'channel_text',
  CHANNEL_TEMPLATE: 'channel_template',
  EMAIL: 'email',
  NOT_SENT: 'not_sent'
} as const
export type OrderMessageRoute = (typeof OrderMessageRoutes)[keyof typeof OrderMessageRoutes]

// What a request to send answered: it went, it did not (with its reason), or the key had been used and the answer is the earlier
// one
export const OrderMessageOutcomeStatus = {
  SENT: 'sent',
  NOT_SENT: 'not_sent',
  DUPLICATE: 'duplicate',
  // An automatic message of a kind whose template is not set to go by itself: nothing is sent and nothing is recorded
  SKIPPED: 'skipped'
} as const

// Who asked for the message: a rule of the platform (a carrier event, a creation, a status change that asked to notify) or a
// person pressing "send"
export const OrderMessageTriggers = {
  AUTOMATIC: 'automatic',
  MANUAL: 'manual'
} as const
export type OrderMessageTrigger = (typeof OrderMessageTriggers)[keyof typeof OrderMessageTriggers]

// What the editor of a template tells the owner about it without refusing it (TDD_17 §4.7)
export const OrderMessageWarnings = {
  // An automatic template that uses `scheduledDeliveryDate`: every order without a date would go unsent
  AUTO_SEND_NEEDS_SCHEDULED_DATE: 'auto_send_needs_scheduled_date'
} as const
export type OrderMessageWarning = (typeof OrderMessageWarnings)[keyof typeof OrderMessageWarnings]

export const OrderMessageLimits = {
  // The text of a message goes through a channel that stores at most MessageLimits.CONTENT_MAX_LENGTH (4096); the body
  // leaves room for what the variables add (a list of items is the longest)
  BODY_MAX_LENGTH: 2000,
  // The numbered placeholders of a channel-approved template (a channel allows far fewer than this)
  CHANNEL_TEMPLATE_VARIABLES_MAX: 10,
  // The values the sample order of the preview takes, longest first: itemsList
  VALUE_MAX_LENGTH: 1000
} as const

// How often the customer is told that a delivery attempt failed: the preference
// orders.failedAttemptMessages (TDD_17 §4.14). It replaces autoSend for ORDER_FAILED_ATTEMPT.
export const FailedAttemptMessagePolicy = {
  EVERY_ATTEMPT: 'every_attempt',
  FIRST_ONLY: 'first_only',
  NONE: 'none'
} as const
export type FailedAttemptMessagePolicyType =
  (typeof FailedAttemptMessagePolicy)[keyof typeof FailedAttemptMessagePolicy]

// GET /orders/:id/print/:doc (TDD_09 §5.4). The order summary is the PDF that can travel with the
// summary message (TDD_17 §4.7).
export const OrderPrintDocuments = {
  PACKING_SLIP: 'packing_slip', // For the warehouse
  INVOICE: 'invoice', // For the customer
  SHIPPING_LABEL: 'shipping_label', // For the courier: the carrier's stored label
  ORDER_SUMMARY: 'order_summary'
} as const
export type OrderPrintDocument = (typeof OrderPrintDocuments)[keyof typeof OrderPrintDocuments]

// Factory cancellation reasons (TDD_09 §5.3): the seed of the per-store list in the preference
// orders.cancellationReasons (TDD_17 §4.14). Each value is an i18n key; a store adds, renames or
// removes entries in Settings → Preferences without code, a custom entry carrying its own label.
export const OrderCancellationReasons = {
  CUSTOMER_REQUEST: 'orders.cancellationReason.customerRequest',
  OUT_OF_STOCK: 'orders.cancellationReason.outOfStock',
  PAYMENT_FAILED: 'orders.cancellationReason.paymentFailed',
  UNDELIVERABLE_ADDRESS: 'orders.cancellationReason.undeliverableAddress',
  DUPLICATE: 'orders.cancellationReason.duplicate',
  OTHER: 'orders.cancellationReason.other'
} as const
export type OrderCancellationReason =
  (typeof OrderCancellationReasons)[keyof typeof OrderCancellationReasons]

// Order.recipientPhones (TDD_02 §13): the numbers the carriers receive, as national digits with no country code.
// A carrier adapter and the label of `CarrierCapability.INTERNAL_GUIDE` join them with LIST_SEPARATOR through formatPhoneList.
export const RecipientPhones = {
  MAX_COUNT: 3,
  // The shortest number a person can dial anywhere the stores sell: fewer digits is a typo, not a phone
  MIN_DIGITS: 6,
  // E.164 allows 15 digits in all, the country code included, so no national number is longer
  MAX_DIGITS: 15,
  LIST_SEPARATOR: ' / '
} as const

export function formatPhoneList(phones: readonly string[]): string {
  return phones.join(RecipientPhones.LIST_SEPARATOR)
}

// Money is whole USD cents (TDD_02 §13); the totals are Int columns of 32 bits
export const ORDER_MAX_AMOUNT_CENTS = 2_147_483_647

export const OrderLimits = {
  // Lines of one order; a cart longer than this is a purchase order, which this module does not take
  MAX_LINES: 100,
  MAX_QUANTITY_PER_LINE: 10_000,
  // Warehouses one line can be split across (a store has few; the server checks the real links)
  MAX_ALLOCATIONS_PER_LINE: 20,
  // Orders one "mark as confirmed" of the list may name (each is a change of its own, so the call stays bounded)
  BULK_CONFIRM_MAX: 100,
  CUSTOMER_NOTES_MAX_LENGTH: 1000,
  // The same ceiling as the customer's notes (owner, 2026-11-10)
  INTERNAL_NOTES_MAX_LENGTH: 1000,
  PACKING_NOTES_MAX_LENGTH: 1000,
  // The reason of a discount, of a fee outside its range, and of a price change
  PRICE_REASON_MAX_LENGTH: 500,
  CANCELLATION_REASON_MAX_LENGTH: 500,
  PAYMENT_REFERENCE_MAX_LENGTH: 100,
  // The text of the search box of the orders list: an order number or a piece of the name, e-mail or phone of the customer
  SEARCH_MAX_LENGTH: 100,
  TRACKING_NUMBER_MAX_LENGTH: 100
} as const

// orders.freeShippingRule (TDD_17 §4.13, §4.14): when an order counts as free shipping
export const OrderFreeShippingRules = {
  ALL_ITEMS: 'all_items',
  ANY_ITEM: 'any_item'
} as const
export type OrderFreeShippingRule =
  (typeof OrderFreeShippingRules)[keyof typeof OrderFreeShippingRules]

// GET /orders, scheduled delivery (decision D18): inclusive days from and to, or one shortcut resolved with the
// timezone of the store. The names are the query keys; nobody writes them inline.
export const OrderScheduleFilters = {
  FROM: 'scheduledDeliveryFrom',
  TO: 'scheduledDeliveryTo',
  ON: 'scheduledDeliveryOn'
} as const

export const OrderScheduledDeliveryShortcuts = {
  TODAY: 'today',
  TOMORROW: 'tomorrow'
} as const
export type OrderScheduledDeliveryShortcut =
  (typeof OrderScheduledDeliveryShortcuts)[keyof typeof OrderScheduledDeliveryShortcuts]

// GET /orders and GET /orders/export, the day the order was made (inclusive days on the clock of the store), and the
// text search. Together with `OrderScheduleFilters` these are the filters of the list, and the names are the keys of
// the query and of the URL of the page.
export const OrderListFilters = {
  Q: 'q',
  STATUS: 'status',
  PAYMENT_STATUS: 'paymentStatus',
  PRICE_APPROVAL_STATUS: 'priceApprovalStatus',
  CUSTOMER_ID: 'customerId',
  CREATED_FROM: 'createdFrom',
  CREATED_TO: 'createdTo',
  // The carrier the order is planned for, and whether it holds a live guide (TDD_17 §4.13, Step 4.14)
  CARRIER_CONNECTION_ID: 'carrierConnectionId',
  GUIDE: 'guide',
  SORT: 'sort'
} as const

// The two readings of the guide filter: an order with a guide that still holds it (not cancelled, failed or returned) and one
// with none. A guide that was voided leaves its order "without a guide", ready to make another.
export const OrderGuideFilters = {
  WITH: 'with_guide',
  WITHOUT: 'without_guide'
} as const
export type OrderGuideFilter = (typeof OrderGuideFilters)[keyof typeof OrderGuideFilters]

// The orders of GET /orders come newest first unless the caller asks for the days of delivery, soonest first
export const OrderSorts = {
  NEWEST: 'newest',
  SCHEDULED_DELIVERY: 'scheduled_delivery'
} as const
export type OrderSort = (typeof OrderSorts)[keyof typeof OrderSorts]

export const OrderResourceTypes = {
  ORDER: 'order'
} as const

// The order number of a store counts from 1 and is shown with at least this many digits ('00001'): a number is
// searched by its prefix (TDD_08 §5.4), so every number of a store has the same length until it passes 99 999
export const OrderNumber = {
  MIN_DIGITS: 5,
  // The counter is an Int column: a store never gets near it
  MAX: ORDER_MAX_AMOUNT_CENTS
} as const

export function formatOrderNumber(sequence: number): string {
  return String(sequence).padStart(OrderNumber.MIN_DIGITS, '0')
}

// What the answer of a create or an edit says the server did not do that the request asked for (`notices`)
export const OrderNotices = {
  // confirmOnCreate was checked but the order waits for a price approval: it is created pending (TDD_17 §4.3)
  CONFIRMATION_SKIPPED_PRICE_APPROVAL: 'confirmation_skipped_price_approval'
} as const

// What the draft of a copied order warns about, one per line it concerns (`GET /orders/:id/copy`, TDD_17 §4.3): the
// line stays in the draft so the agent sees it and decides, and the normal create refuses it if it is still wrong then
export const OrderCopyWarnings = {
  PRODUCT_INACTIVE: 'product_inactive',
  // The variant of the line is switched off or no longer exists
  VARIANT_UNAVAILABLE: 'variant_unavailable',
  // The product has variants now and the line names none
  VARIANT_REQUIRED: 'variant_required',
  OUT_OF_STOCK: 'out_of_stock',
  PRICE_CHANGED: 'price_changed'
} as const

export type OrderCopyWarningCode = (typeof OrderCopyWarnings)[keyof typeof OrderCopyWarnings]

// What `metadata.conflict` says when a 409 of an order has several causes
export const OrderConflicts = {
  CUSTOMER_ERASED: 'customer_erased',
  PRODUCT_INACTIVE: 'product_inactive',
  VARIANT_INACTIVE: 'variant_inactive',
  VARIANT_REQUIRED: 'variant_required',
  DELIVERED_IN_THE_FUTURE: 'delivered_in_the_future',
  DELIVERED_BEFORE_SHIPPED: 'delivered_before_shipped'
} as const

// Who is told when the packing note changes on an order that is already confirmed: the members who may prepare or
// ship orders of the store (the permissions are named in libs/core/domain/auth/permissions.ts)
export const PackingNoteNotice = {
  // The statuses in which a change of the note warns the warehouse (a PENDING_CONFIRMATION order is not packed yet)
  STATUSES: [OrderStatus.CONFIRMED, OrderStatus.PREPARING] as readonly OrderStatus[],
  // The members told: whoever may move an order to PREPARING or SHIPPED by hand, and whoever makes its guide
  PERMISSIONS: [
    Permissions.ORDERS_CHANGE_STATUS,
    Permissions.SHIPPING_MANAGE
  ] as readonly Permission[]
} as const

// The lock that makes the orders of a store take turns while their stock is allocated (one scope, one order of locks:
// the order, this one, then the levels)
export const OrderLockScopes = {
  ALLOCATION: 'order-allocation'
} as const

// What an order does to its stock, per allocation (TDD_16 §4.1); each is the last part of the idempotency key
export const OrderStockEffects = {
  RESERVE: 'reserve',
  RELEASE: 'release',
  ISSUE: 'issue',
  RETURN: 'return'
} as const
export type OrderStockEffect = (typeof OrderStockEffects)[keyof typeof OrderStockEffects]

// The key of one movement of an order: the same effect on the same allocation never applies twice
export function orderMovementKey(
  orderId: string,
  itemId: string,
  warehouseId: string,
  effect: OrderStockEffect
): string {
  return `order:${orderId}:${itemId}:${warehouseId}:${effect}`
}

// The statuses in which the price of an order can still be decided (approved or rejected): the ones that can still change
export const OrderEditablePriceStatuses: readonly OrderStatus[] = [
  OrderStatus.PENDING_CONFIRMATION,
  OrderStatus.CONFIRMED,
  OrderStatus.PREPARING
]

// The message a status that a person set by hand calls for (TDD_09 §5.3): its "Notify customer" box starts from the `autoSend`
// of the template of this kind. A status the order reaches by following its shipment is told by the shipment's own message.
export const OrderStatusMessageKinds: Readonly<Partial<Record<OrderStatus, OrderMessageKindType>>> =
  {
    [OrderStatus.SHIPPED]: OrderMessageKind.ORDER_SHIPPED,
    [OrderStatus.DELIVERED]: OrderMessageKind.ORDER_DELIVERED,
    [OrderStatus.CANCELLED]: OrderMessageKind.ORDER_CANCELLED
  }
