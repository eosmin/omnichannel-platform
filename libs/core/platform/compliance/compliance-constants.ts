import type { RetentionField } from '@platform/core/domain'

// Whether the executor of approved erasures exists (the sweep of Step 7.2-H2b). A function, not a bare constant read in a condition: the
// day it ships this returns true and nothing else changes
export const dsrExecutorAvailable = (): boolean => DSR_EXECUTOR_AVAILABLE
const DSR_EXECUTOR_AVAILABLE = false

export const ComplianceConfig = {
  DSR_RESPONSE_DEADLINE_DAYS: 30,
  DSR_DEADLINE_ALERT_DAY: 25,
  DSR_EXTENSION_DAYS: 60,
  DSR_VERIFICATION_TOKEN_DAYS: 7,
  DSR_EXPORT_LINK_DAYS: 7,
  BREACH_NOTIFICATION_HOURS: 72,
  ERASURE_GRACE_PERIOD_DAYS: 30,
  UNMERGE_WINDOW_DAYS: 30,
  ERASED_CONTENT_PLACEHOLDER: '[erased]', // Written into Message.content on erasure
  // The clearing of the data of an erased customer runs again shortly after the first time and, in the sweep, for this many days after it was
  // marked: a write that was in flight when the erasure committed (a reply, an inbound message, a file that was being fetched) lands after the
  // first run, and a lock on the customer in the paths that write would invert the order of the merge (deadlock)
  ERASED_DATA_RECHECK_DELAY_MS: 15 * 60 * 1000,
  ERASED_DATA_RECHECK_DAYS: 2,
  // Approvals an erasure request needs before its grace period starts (Step 7.2-H1, owner decision of the coordinator): one in the
  // MVP, the audit keeps each approver so a store can ask for two
  DSR_ERASURE_APPROVALS_REQUIRED: 1,
  // The public intake (TDD_05 §10.2): what one address, one store and one body may cost, so the form cannot be used to mail a third party
  DSR_INTAKE_PER_EMAIL_PER_DAY: 3,
  DSR_INTAKE_PER_STORE_PER_DAY: 50,
  DSR_INTAKE_JOB_TTL_MS: 60 * 60 * 1000
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
export const RetentionResourceTypes = {
  RETENTION_SETTINGS: 'retention_settings',
  // The resource of the entry of a nightly run of the worker: the store of a retention run, the platform for the others
  STORE: 'store',
  PLATFORM: 'platform'
} as const

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
  USED_TOKEN_GRACE_DAYS: 1,
  // An invitation that nobody accepted stays in the list of the team as expired (it is how the person is
  // invited again); it is deleted this long after it expired (MVP_TRIM_CHECKLIST §10 item 21). An accepted or
  // revoked one is the history of who joined and is not touched here
  EXPIRED_INVITATION_GRACE_DAYS: 30
} as const

// The cold export of the audit log (TDD_05 §9.3): whole calendar months that are entirely past the hot window, the
// oldest first, at most MAX_MONTHS_PER_RUN a run. A month is one object, so it is never written twice with
// different rows.
export const AuditColdExport = {
  HOT_DAYS: DataRetentionPolicies.AUDIT_LOGS_HOT.defaultDays,
  READ_BATCH: 1000,
  // One purge entry is written for each batch, so the batch is the most the function takes (5000)
  DELETE_BATCH: 5000,
  // The purge rule the database function writes in the audit entry of a purge (migration 20270121100000)
  PURGE_RULE: 'audit-cold-export',
  MAX_MONTHS_PER_RUN: 3,
  CONTENT_TYPE: 'application/gzip',
  // The most a month may hold its lock (the transaction that holds it). Past it the database ends the transaction and
  // the lock is let go; a process that dies lets it go at once, because the connection closes
  LOCK_TIMEOUT_MS: 2 * 60 * 60 * 1000,
  LOCK_MAX_WAIT_MS: 5_000
} as const

// What the viewer of the audit log may read of the cold parts (TDD_05 §9.3) in one request. The archive is read as a stream and
// only the page being asked for is kept in memory; these are the ceilings of the time and the bytes a request may spend on it.
// A request that reaches one is refused (never answered with a page that is short of entries it did not reach).
export const AuditColdRead = {
  // The prefix every object of the cold export lives under (`StorageKeys.auditArchive`)
  PREFIX: 'audit/',
  // Objects the listing of the prefix may return before the read gives up (pages of the bucket listing)
  MAX_LIST_PAGES: 20,
  // Parts (objects) one request may open
  MAX_PARTS: 120,
  // The bytes of the objects (gzipped) one request may read, and the bytes they may inflate to (a bomb guard)
  MAX_COMPRESSED_BYTES: 512 * 1024 * 1024,
  MAX_INFLATED_BYTES: 4 * 1024 * 1024 * 1024,
  // A line longer than this is not an audit entry of ours: the read stops instead of buffering it
  MAX_LINE_BYTES: 1024 * 1024,
  // The time one request may spend reading the archive
  MAX_READ_MS: 60_000
} as const

// The advisory lock of the cold export of one month: two runs of the same month (a job given again as stalled, two
// replicas, a hand-added job) never export it at the same time
export const auditColdExportLockKey = (year: number, month: number): string =>
  `audit-cold-export-${year}-${month}`

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

// The legal basis of each purpose is a fact of the purpose, not a choice of whoever records the row: a body that named its
// own basis could write a "consent" for something that rests on the contract. The record takes it from here.
export const ConsentPurposeLegalBasis: Record<
  ConsentPurpose,
  (typeof LegalBases)[keyof typeof LegalBases]
> = {
  [ConsentPurposes.ORDER_MESSAGES]: LegalBases.CONTRACT
}

// Where a `ConsentRecord` came from (`ConsentRecord.source`). Only the team of the store records one today.
export const ConsentSources = {
  STAFF: 'staff'
} as const

// A customer's consent history is append-only (the latest row of a purpose is the current answer), so the list is a page of
// the newest rows, not the whole table.
export const ConsentListLimits = { MAX_ROWS: 100 } as const

// The categories, the policy version and the cookie of the choice live in the domain, in a file of their own (`@platform/core/cookie-consent`) and
// not in its barrel: the web reads them, and a barrel travels whole in the script of every page
export {
  ChoosableCookieCategories,
  type ChoosableCookieCategory,
  COOKIE_CONSENT_COOKIE_MAX_AGE_SECONDS,
  COOKIE_CONSENT_COOKIE_NAME,
  COOKIE_POLICY_VERSION,
  CookieCategories
} from '@platform/core/cookie-consent'

export const CookieConsentLimits = {
  // The id the browser makes for itself (a random UUID): the length of one, with room for the dashes
  VISITOR_ID_LENGTH: 36,
  USER_AGENT_MAX_LENGTH: 512
} as const

// The key that hashes the address of a visitor in `CookieConsent.ipHash`. Derived from the signing secret with its own label by
// `CompliancePlatformModule`; the token lives here so that what uses it imports no env.
export const COOKIE_CONSENT_HASH_KEY = Symbol('COOKIE_CONSENT_HASH_KEY')

// What the public flow of data requests needs from the validated env, derived once (`CompliancePlatformModule`): whether it is on, the key
// that hashes an address, and the key that seals the job of the intake
export const DSR_CONFIG = Symbol('DSR_CONFIG')
export interface DsrConfig {
  enabled: boolean
  hashKey: string
  encryptionKeyHex: string
}

// The page of the web app that confirms a data request, and the key of the fragment that carries the token (the browser never sends a fragment
// to a server, so the token stays out of access logs)
export const DSR_VERIFY_WEB_PATH = '/compliance/dsr/verify'
export const DSR_VERIFY_FRAGMENT_KEY = 'token'

// What a data subject request is called where a text is needed (the kind of resource of an audit entry, who the request is about), and why
// the flow itself closes a request. Never typed at a call site (rule 1).
export const DsrResourceTypes = { REQUEST: 'data_subject_request' } as const
export const DsrSubjectTypes = { CUSTOMER: 'customer' } as const
export const DsrRejectionReasons = {
  VERIFICATION_MAIL_NOT_QUEUED: 'verification_mail_not_queued'
} as const
