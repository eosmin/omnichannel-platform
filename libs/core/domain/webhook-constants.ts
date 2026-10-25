// Headers of the tenant-configured outbound webhooks. The signature header is the one the plugin
// manifest example documents (TDD_10 §6.5); the event and delivery headers follow its pattern.
export const WebhookHeaders = {
  SIGNATURE: 'x-platform-signature',
  EVENT: 'x-platform-event',
  DELIVERY: 'x-platform-delivery'
} as const

export const WebhookLimits = {
  MAX_CONSECUTIVE_FAILURES: 20 // The webhook is auto-disabled and its admins are notified once
} as const

// Where an inbound provider webhook comes from, for the idempotency table (ProcessedWebhookEvent).
export const WebhookSources = { RESEND: 'resend' } as const
export type WebhookSource = (typeof WebhookSources)[keyof typeof WebhookSources]

// The event types Resend sends (https://resend.com/docs/webhooks/event-types) that the platform handles.
export const ResendEventTypes = {
  EMAIL_OPENED: 'email.opened',
  EMAIL_CLICKED: 'email.clicked',
  EMAIL_BOUNCED: 'email.bounced',
  EMAIL_FAILED: 'email.failed',
  EMAIL_COMPLAINED: 'email.complained',
  EMAIL_RECEIVED: 'email.received' // Inbound email channel, TDD_10 §5.5
} as const
export type ResendEventType = (typeof ResendEventTypes)[keyof typeof ResendEventTypes]

// data.bounce.type of an email.bounced event. Only a permanent one (a hard bounce) says the address
// cannot receive mail; a transient one (a full mailbox) can pass. Compared in lower case.
export const ResendBounceTypes = { PERMANENT: 'permanent' } as const
