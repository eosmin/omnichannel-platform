// Cron expressions for every scheduler, defined once (TDD_07 §4). An inline cron string anywhere
// else is a lint failure.
export const Schedules = {
  ROLLUP_HOURLY: '5 * * * *', // :05 every hour, previous hour
  ROLLUP_DAILY: '15 0 * * *', // 00:15 UTC, previous day
  ENFORCE_RETENTION: '0 * * * *', // Hourly; picks stores whose local time is 03:00 (TDD_05 §10.4)
  CLEANUP_PLATFORM_DATA: '0 1 * * *', // 01:00 UTC: sessions, tokens, deliveries, exports, merges
  EXPORT_AUDIT_LOGS: '0 2 1 * *', // 02:00 UTC on the 1st: cold export + purge (TDD_05 §9.3)
  WAKE_SNOOZED: '* * * * *', // Every minute
  AUTO_ARCHIVE_RESOLVED: '30 * * * *', // Hourly
  DISPATCH_REPORTS: '0 * * * *', // Hourly, checks per-store send hour
  SEND_EMAIL_DIGEST_HOURLY: '10 * * * *',
  SEND_EMAIL_DIGEST_DAILY: '10 8 * * *', // 08:10 in each user's timezone (checked per user)
  CHECK_CHANNEL_HEALTH: '*/5 * * * *', // Every 5 minutes (TDD_10 §10)
  CHECK_DSR_DEADLINES: '0 7 * * *', // 07:00 UTC daily (TDD_05 §10.2)
  COLLECT_QUEUE_METRICS: '*/15 * * * * *', // Every 15 seconds (6-field cron, @nestjs/schedule)
  RECONCILE_INVENTORY: '0 4 * * *', // 04:00 UTC daily, one job per store (TDD_16 §4.8)
  EVALUATE_PICKUPS: '* * * * *', // Every minute; the job decides which connections are due (TDD_17 §4.10)
  POLL_SHIPMENT_STATUS: '*/10 * * * *', // The job applies each connection's own interval
  CLEAN_BULK_LABELS: '30 3 * * *',
  CHECK_REMITTANCES: '0 15 * * *' // Daily
} as const

export type ScheduleName = keyof typeof Schedules

export const LockNames = Object.fromEntries(
  Object.keys(Schedules).map(k => [k, k.toLowerCase()])
) as unknown as Record<ScheduleName, string> // Object.fromEntries loses the key type; the keys are exactly Schedules'
