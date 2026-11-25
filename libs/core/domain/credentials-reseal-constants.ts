// The re-seal of every sealed value OUTSIDE the fiscal area after a rotation of CREDENTIALS_ENCRYPTION_KEY (Step 7.3-S11c). The fiscal area has
// its own (FiscalReseal, Step 7.3-S11b). A target is one sealed COLUMN of one table: the list below is closed, and a spec reads the Prisma
// schema to fail when a column that holds a sealed value is not on it (or in the list of what is left to expire).

// Which sealed column a log line, an audit entry or a failure counter names (the label an operator filters on). Never a value.
export const SealedTargetIds = {
  CONNECTION_CREDENTIALS: 'connection-credentials',
  CARRIER_CREDENTIALS: 'carrier-credentials',
  CARRIER_WEBHOOK_SECRET: 'carrier-webhook-secret',
  WEBHOOK_SECRET: 'webhook-secret',
  PLUGIN_WEBHOOK_SECRET: 'plugin-webhook-secret',
  PLUGIN_COMMAND_SECRET: 'plugin-command-secret',
  PLUGIN_COMMAND_SECRET_PREVIOUS: 'plugin-command-secret-previous',
  INVITATION_OUTBOX: 'invitation-outbox',
  DSR_NOTIFY_ADDRESS: 'dsr-notify-address',
  DSR_EXPORT_PASSWORD: 'dsr-export-password'
} as const
export type SealedTargetId = (typeof SealedTargetIds)[keyof typeof SealedTargetIds]

// How a sealed column is read: a set of credentials (a JSON object) or a plain text
export const SealedFormats = { JSON: 'json', TEXT: 'text' } as const
export type SealedFormat = (typeof SealedFormats)[keyof typeof SealedFormats]

// The kind of resource an audit entry of a re-seal names (the row that holds the value)
export const SealedResourceTypes = {
  CHANNEL_CONNECTION: 'channel_connection',
  CARRIER_CONNECTION: 'carrier_connection',
  WEBHOOK: 'webhook',
  PLUGIN_INSTALLATION: 'plugin_installation',
  INVITATION: 'invitation',
  DATA_SUBJECT_REQUEST: 'data_subject_request'
} as const

export const CredentialsReseal = {
  // Rows read and swapped per page of one target of one organization
  PAGE_SIZE: 100,
  // The most values of one target that one run of one organization seals again (or fails on): the rows already current are only skipped and
  // do not count, so the next night reaches the rest
  MAX_VALUES_PER_TARGET: 5000,
  // The most values of one target that one run READS (already current, failed or sealed again): a column full of values that never open does
  // not hold the run on the same first rows, because only the ones sealed again (or lost to a conflict) count against the cap above
  MAX_SCANNED_PER_TARGET: 50_000,
  // The most failures one run of one organization writes to the log (the report counts all of them, by code)
  MAX_LOGGED_FAILURES: 20,
  // The limits of the context of the organization of ONE unit of work (a page, a value)
  CONTEXT_MAX_WAIT_MS: 10_000,
  CONTEXT_TIMEOUT_MS: 30_000,
  // Organizations listed per page by the nightly schedule, and the tries of the job of one organization
  ORGANIZATIONS_PAGE_SIZE: 200,
  JOB_ATTEMPTS: 3,
  JOB_BACKOFF_MS: 60_000
} as const

export const CredentialsResealOutcome = {
  CURRENT: 'current',
  RESEALED: 'resealed',
  CONFLICT: 'conflict'
} as const
export type CredentialsResealOutcome =
  (typeof CredentialsResealOutcome)[keyof typeof CredentialsResealOutcome]

// A write the database refused (not a damaged row), and a value sealed again that did not open to the same content (nothing was written)
export const CREDENTIALS_RESEAL_WRITE_FAILED = 'write_failed'
export const CREDENTIALS_RESEAL_MISMATCH = 'reseal_mismatch'
