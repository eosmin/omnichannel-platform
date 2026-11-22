import { type EventName, Events } from './events/event-names'

// Headers of the tenant-configured outbound webhooks. The signature header is the one the plugin
// manifest example documents (TDD_10 §6.5); the event and delivery headers follow its pattern.
export const WebhookHeaders = {
  SIGNATURE: 'x-platform-signature',
  EVENT: 'x-platform-event',
  DELIVERY: 'x-platform-delivery'
} as const

// Who is calling: a receiver behind a firewall that refuses a request with no User-Agent would fail every delivery for good
export const WEBHOOK_USER_AGENT = 'Platform-Webhooks/1.0'

// Why a write to a webhook was refused with a conflict (`details.reason` of the answer), so that the client tells them apart
export const WebhookConflictReasons = {
  DUPLICATE: 'duplicate_webhook' // The store already has one for the same events at the same address
} as const

export const WebhookLimits = {
  MAX_CONSECUTIVE_FAILURES: 20, // The webhook is auto-disabled and its admins are notified once
  MAX_PER_STORE: 20, // The list of the settings page is returned whole, so the count bounds it
  URL_MAX_LENGTH: 2048,
  SECRET_BYTES: 32,
  DELIVERY_TIMEOUT_MS: 10_000,
  DELIVERIES_DEFAULT_PAGE_SIZE: 50,
  DELIVERIES_MAX_PAGE_SIZE: 100,
  // What the log keeps of a failure: it is read by the owner of the endpoint, never a whole response
  DELIVERY_ERROR_MAX_LENGTH: 500,
  // The day a plugin's `maxWebhooksPerDay` is counted over: the last 24 hours, so there is no midnight at which a burst doubles
  PLUGIN_DAY_MS: 86_400_000,
  // What the log says of a delivery dropped because the cap of the day was reached
  DAILY_CAP_REACHED_CODE: 'daily_cap_reached',
  // What one installation may be allowed in a day whatever its manifest says: the places of the day are kept in Redis (one entry per
  // delivery), so the ceiling bounds the memory a plugin can take there (about 10 MB at this number)
  PLUGIN_DAY_CAP_CEILING: 100_000
} as const

// What the log of a delivery says when it failed: a code, never a sentence, because the settings page translates it. The code of
// the network error ('ECONNRESET') follows a colon when there is one.
export const WebhookDeliveryErrors = {
  ADDRESS_NOT_ALLOWED: 'address_not_allowed', // The address no longer leads to the public internet
  NOT_RESOLVED: 'not_resolved', // The name did not resolve
  NO_ANSWER: 'no_answer', // The connection failed or was refused
  TOO_SLOW: 'too_slow',
  BAD_STATUS: 'bad_status', // Any answer that is not a 2xx; the status is in its own column
  REQUEST_REFUSED: 'request_refused', // Node refused to build the request
  SECRET_UNREADABLE: 'secret_unreadable', // The sealed secret cannot be opened: make a new one
  UNEXPECTED: 'unexpected'
} as const
export type WebhookDeliveryError =
  (typeof WebhookDeliveryErrors)[keyof typeof WebhookDeliveryErrors]

// The resource types the audit log and the notifications name
export const WEBHOOK_RESOURCE_TYPE = 'webhook'
export const API_KEY_RESOURCE_TYPE = 'api_key'

// The secret of a webhook, shown once when it is made: the receiver checks the signature header with it
export const WEBHOOK_SECRET_PREFIX = 'whsec_'

// The events a store may subscribe a webhook to. A payload is the one the event carries on the bus:
// identifiers and plain values, never the text of a message (TDD_07 §2). Each of these is raised by the
// api, or is one the worker raises and bridges to it (BridgedEvents), because the webhooks are queued by the api. A webhook
// that names any other event is refused when it is created.
export const WebhookEvents = [
  Events.ORDER_CREATED,
  Events.ORDER_UPDATED,
  Events.ORDER_CONFIRMED,
  Events.ORDER_STATUS_CHANGED,
  Events.ORDER_SHIPPED,
  Events.ORDER_DELIVERED,
  Events.ORDER_CANCELLED,
  Events.ORDER_PAYMENT_RECORDED,
  Events.ORDER_PAYMENT_STATUS_CHANGED,
  Events.CUSTOMER_CREATED,
  Events.CUSTOMER_UPDATED,
  Events.CUSTOMER_MERGED,
  Events.CONVERSATION_CREATED,
  Events.CONVERSATION_STATUS_CHANGED,
  Events.CONVERSATION_ASSIGNED,
  Events.MESSAGE_RECEIVED,
  Events.MESSAGE_SENT,
  Events.SHIPMENT_CREATED,
  Events.SHIPMENT_STATUS_CHANGED,
  Events.SHIPMENT_CANCELLED,
  Events.RETURN_REQUESTED,
  Events.RETURN_APPROVED,
  Events.RETURN_IN_TRANSIT,
  Events.RETURN_RECEIVED,
  Events.PRODUCT_CREATED,
  Events.PRODUCT_UPDATED,
  Events.PRODUCT_DELETED
] as const satisfies readonly EventName[]
export type WebhookEvent = (typeof WebhookEvents)[number]

const WEBHOOK_EVENT_SET: ReadonlySet<string> = new Set(WebhookEvents)
export const isWebhookEvent = (event: string): event is WebhookEvent => WEBHOOK_EVENT_SET.has(event)

// Why the deliveries of an event were never queued (the label `reason` of `platform_webhook_dispatch_lost_total`). A store with no
// subscribers, or one that no longer exists, loses nothing and is not counted.
export const WebhookDispatchLossReasons = {
  // The payload of an event of the catalog names no store: a bug of its emitter
  NO_STORE: 'no_store',
  // The webhooks or the plugin installations of the store could not be read (after the tries for a lock or a busy pool)
  READ_FAILED: 'read_failed',
  // The jobs of the deliveries could not be added to the queue (Redis)
  QUEUE_FAILED: 'queue_failed'
} as const
export type WebhookDispatchLossReason =
  (typeof WebhookDispatchLossReasons)[keyof typeof WebhookDispatchLossReasons]

// The pauses between the tries of the read of the dispatcher when the database answers a lock timeout or a busy pool (a transient
// failure): three more tries after the first, under two seconds in all, so the event listener is not held for long.
export const WebhookDispatchReadRetryPausesMs = [100, 400, 1500] as const

// Where an inbound provider webhook comes from, for the idempotency table (ProcessedWebhookEvent).
export const WebhookSources = { RESEND: 'resend' } as const
export type WebhookSource = (typeof WebhookSources)[keyof typeof WebhookSources]

// The event types Resend sends (https://resend.com/docs/webhooks/event-types) that the platform handles.
export const ResendEventTypes = {
  EMAIL_OPENED: 'email.opened',
  EMAIL_CLICKED: 'email.clicked',
  EMAIL_BOUNCED: 'email.bounced',
  EMAIL_FAILED: 'email.failed',
  EMAIL_COMPLAINED: 'email.complained'
} as const
export type ResendEventType = (typeof ResendEventTypes)[keyof typeof ResendEventTypes]

// data.bounce.type of an email.bounced event. Only a permanent one (a hard bounce) says the address
// cannot receive mail; a transient one (a full mailbox) can pass. Compared in lower case.
export const ResendBounceTypes = { PERMANENT: 'permanent' } as const
