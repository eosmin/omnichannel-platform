// Cron expressions for every scheduler, defined once (TDD_07 §4). An inline cron string anywhere
// else is a lint failure.
export const Schedules = {
  ROLLUP_HOURLY: '5 * * * *', // :05 every hour, previous hour
  ROLLUP_DAILY: '15 0 * * *', // 00:15 UTC, previous day
  ENFORCE_RETENTION: '0 * * * *', // Hourly; picks stores whose local time is 03:00 (TDD_05 §10.4)
  CLEANUP_PLATFORM_DATA: '0 1 * * *', // 01:00 UTC: sessions, tokens, deliveries, exports, merges
  EXPORT_AUDIT_LOGS: '0 2 1 * *', // 02:00 UTC on the 1st: cold export + purge (TDD_05 §9.3)
  WAKE_SNOOZED: '* * * * *', // Every minute
  DELIVER_INVITATION_EMAILS: '* * * * *', // Every minute: the emails of invitations that wait in their outbox (Step 7.1-H)
  AUTO_ARCHIVE_RESOLVED: '30 * * * *', // Hourly
  DISPATCH_REPORTS: '0 * * * *', // Hourly, checks per-store send hour
  SEND_EMAIL_DIGEST_HOURLY: '10 * * * *',
  SEND_EMAIL_DIGEST_DAILY: '10 * * * *', // Every hour at :10; sends to the users whose local time is 08:10
  CHECK_CHANNEL_HEALTH: '*/5 * * * *', // Every 5 minutes (TDD_10 §10)
  CHECK_REMOTE_CHANNEL_HEALTH: '*/5 * * * *', // The same, for the plugins that run outside the platform, with a lock of their own (TDD_10 §6.7.7)
  CHECK_TOKEN_EXPIRY: '15 */6 * * *', // Every 6 hours: each connection is asked about once a day at most (TokenExpiryLimits)
  REQUEUE_OUTBOUND: '* * * * *', // Every minute: a reply stored but never queued (Redis was down)
  PURGE_DELETED_MESSAGES: '20 * * * *', // Hourly: the text of a deleted message past its retention
  CLEAN_ORPHAN_MEDIA: '50 * * * *', // Hourly: stray uploads, stuck scans, files of infected rows
  SANITIZE_EXISTING_PICTURES: '*/10 * * * *', // Every 10 minutes: a bounded batch of the pictures stored before the cleaning of metadata existed
  SANITIZE_EXISTING_DOCUMENTS: '5-55/10 * * * *', // Every 10 minutes, five past: a bounded batch of the PDF, docx and xlsx stored before their cleaning existed
  CLEAN_EXPIRED_EXPORTS: '40 * * * *', // Hourly: the files of exports past their date, and the ones that never got made
  CHECK_DSR_DEADLINES: '0 7 * * *', // 07:00 UTC daily (TDD_05 §10.2)
  EXPIRE_DSR_REQUESTS: '25 3 * * *', // 03:25 UTC daily: the data requests whose verification link expired unused (Step 7.2-H1b)
  ERASE_DSR_REQUESTS: '30 5 * * *', // 05:30 UTC daily: the approved erasures whose grace period ended (Step 7.2-H2b-1)
  COLLECT_QUEUE_METRICS: '*/15 * * * * *', // Every 15 seconds (6-field cron, @nestjs/schedule)
  RECONCILE_INVENTORY: '0 4 * * *', // 04:00 UTC daily, one job per store (TDD_16 §4.8)
  RECONCILE_FINANCE: '30 4 * * *', // 04:30 UTC daily, one job per organization with books (TDD_18 §11)
  VERIFY_LEDGER_CHAIN: '0 5 * * 0', // 05:00 UTC on Sundays, one job per organization with books (TDD_18 §3, §11)
  EVALUATE_PICKUPS: '* * * * *', // Every minute; the job decides which connections are due (TDD_17 §4.10)
  POLL_SHIPMENT_STATUS: '*/10 * * * *', // The job applies each connection's own interval
  CLEAN_BULK_LABELS: '30 3 * * *',
  CHECK_REMITTANCES: '0 15 * * *', // Daily
  CLOSE_BENEFIT_PERIODS: '10 6 * * *' // Daily 06:10 UTC: the periods of the refund benefit that ended (TDD_17 §4.18)
} as const

// A run of the snooze and auto-archive sweeps takes batches of conversations, the oldest first (for the
// auto-archive, within each number of days the stores chose), and
// repeats while a batch comes back full, up to MAX_BATCHES. A run that ends on a full batch says so in
// the log, and the next run takes the rest.
export const ConversationSweep = {
  BATCH: 200,
  MAX_BATCHES: 10
} as const

export type ScheduleName = keyof typeof Schedules

export const LockNames = Object.fromEntries(
  Object.keys(Schedules).map(k => [k, k.toLowerCase()])
) as unknown as Record<ScheduleName, string> // Object.fromEntries loses the key type; the keys are exactly Schedules'
