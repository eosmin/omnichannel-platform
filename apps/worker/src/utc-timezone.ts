// The cron schedules (`Schedules` in libs/core/platform/queues/schedules.ts) are written and documented in UTC, but
// `@nestjs/schedule` runs a `@Cron` in the time zone of the process unless the decorator names one, and none does.
// A worker started on a machine in another zone (a laptop in Asia/Dubai, UTC+4, ran RECONCILE_FINANCE, `30 4 * * *`,
// at 00:30 UTC) fired at the wrong hour. Production already runs in UTC; this makes every environment do the same.
// Imported FIRST by main.ts, before anything that reads or schedules a date.
process.env.TZ = 'UTC'
