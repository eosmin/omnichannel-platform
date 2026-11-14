import type { RetentionField } from '@platform/core/domain'

export const ComplianceConfig = {
  DSR_RESPONSE_DEADLINE_DAYS: 30,
  DSR_DEADLINE_ALERT_DAY: 25,
  DSR_EXTENSION_DAYS: 60,
  DSR_VERIFICATION_TOKEN_DAYS: 7,
  DSR_EXPORT_LINK_DAYS: 7,
  BREACH_NOTIFICATION_HOURS: 72,
  ERASURE_GRACE_PERIOD_DAYS: 30,
  UNMERGE_WINDOW_DAYS: 30,
  ERASED_CONTENT_PLACEHOLDER: '[erased]' // Written into Message.content on erasure
} as const

// Platform-wide floors and ceilings. Tenant-configurable values live in RetentionSettings, and
// the effective window is RetentionSettings only (the v1.2 MVP has no plans).
export const DataRetentionPolicies = {
  CONVERSATIONS: { defaultDays: 730, configurable: true }, // Messages follow conversations
  MEDIA: { defaultDays: 365, configurable: true },
  ORDERS: { defaultDays: 2555, configurable: false }, // Tax: 7 years
  AUDIT_LOGS_HOT: { defaultDays: 730, configurable: false }, // Then cold storage, TDD_05 §9.3
  AUDIT_LOGS_COLD: { defaultDays: 2555, configurable: false },
  ANALYTICS_EVENTS: { defaultDays: 395, configurable: true },
  SESSIONS: { defaultDays: 30, configurable: false },
  VERIFICATION_TOKENS: { defaultDays: 7, configurable: false },
  NOTIFICATIONS: { defaultDays: 90, configurable: true },
  WEBHOOK_DELIVERIES: { defaultDays: 30, configurable: false },
  EXPORTS: { defaultDays: 7, configurable: false },
  CUSTOMER_MERGES: { defaultDays: 30, configurable: false },
  // The rollup by the hour is a fine view of the recent past; the daily rollup (and its 800-day range) is what
  // answers the long questions, so the hours go after three months
  METRICS_HOURLY: { defaultDays: 90, configurable: false }
} as const

// The bounds of the windows live in the domain, where the web reads them too (the form of Settings → Data retention)
export { RetentionBounds, type RetentionField } from '@platform/core/domain'

// The resource of the audit entry of a change to the windows
export const RetentionResourceTypes = { RETENTION_SETTINGS: 'retention_settings' } as const

// The windows of a store that has no RetentionSettings row yet (a row is made with the store, so this is the
// guard against a store made by hand): the factory defaults of the table
export const RetentionDefaults = {
  conversationDays: DataRetentionPolicies.CONVERSATIONS.defaultDays,
  mediaDays: DataRetentionPolicies.MEDIA.defaultDays,
  analyticsDays: DataRetentionPolicies.ANALYTICS_EVENTS.defaultDays,
  notificationDays: DataRetentionPolicies.NOTIFICATIONS.defaultDays
} as const satisfies Record<RetentionField, number>

// The retention run of a store (TDD_05 §10.4): the hourly scheduler picks the stores whose local clock reads
// LOCAL_HOUR, and each category takes batches of BATCH_SIZE rows up to MAX_BATCHES of them, oldest first. A
// category that stops on a full batch says so in the log, and the next night takes the rest.
export const RetentionRun = {
  LOCAL_HOUR: 3,
  BATCH_SIZE: 500,
  MAX_BATCHES: 40,
  // A conversation takes its messages, revisions, reactions and files with it, so it goes in smaller batches (and a
  // batch the database refuses is retried one by one): the transaction must end inside TRANSACTION_TIMEOUT_MS
  CONVERSATION_BATCH_SIZE: 100,
  CONVERSATION_MAX_BATCHES: 100,
  TRANSACTION_TIMEOUT_MS: 60_000,
  // A batch of at least this many conversations that the database refuses all, one by one, is the database and not the rows
  SYSTEMIC_REFUSALS: 10,
  // Objects of the bucket deleted at the same time
  FILE_DELETE_CONCURRENCY: 10,
  // The stores read to make the jobs of an hour, a page at a time
  STORES_PAGE_SIZE: 500
} as const

// The platform cleanup of every day (TDD_05 §10.4): batches of BATCH_SIZE rows for each category, up to MAX_BATCHES
export const PlatformCleanup = {
  BATCH_SIZE: 500,
  MAX_BATCHES: 100,
  // A verification token that was used is useless, and is deleted this long after it was used (an expired one, at once):
  // the day lets a person who opens a link twice, or a support check, still read what happened
  USED_TOKEN_GRACE_DAYS: 1
} as const

// The cold export of the audit log (TDD_05 §9.3): whole calendar months that are entirely past the hot window, the
// oldest first, at most MAX_MONTHS_PER_RUN a run. A month is one object, so it is never written twice with
// different rows.
export const AuditColdExport = {
  HOT_DAYS: DataRetentionPolicies.AUDIT_LOGS_HOT.defaultDays,
  READ_BATCH: 1000,
  DELETE_BATCH: 500,
  MAX_MONTHS_PER_RUN: 3,
  CONTENT_TYPE: 'application/gzip'
} as const

export const LegalBases = {
  CONSENT: 'consent',
  CONTRACT: 'contract',
  LEGAL_OBLIGATION: 'legal_obligation',
  LEGITIMATE_INTERESTS: 'legitimate_interests'
} as const

// What a `ConsentRecord` of a customer is for. Only the purposes the platform reads are named here.
export const ConsentPurposes = {
  // Messages about an order the customer placed (TDD_17 §4.7). They rest on the contract (`LegalBases.CONTRACT`), so having
  // no record is not a refusal; a record with `granted: false` is, and nothing is sent to that customer
  ORDER_MESSAGES: 'order_messages'
} as const
export type ConsentPurpose = (typeof ConsentPurposes)[keyof typeof ConsentPurposes]

export const CookieCategories = {
  NECESSARY: 'necessary', // No consent required
  FUNCTIONAL: 'functional', // Language, last store
  ANALYTICS: 'analytics', // Product usage
  MARKETING: 'marketing' // Not used currently
} as const

// A new version re-prompts the cookie consent.
export const COOKIE_POLICY_VERSION = '2026-09-01'
