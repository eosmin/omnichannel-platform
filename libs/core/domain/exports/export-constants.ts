export const ExportLimits = {
  // Rows read from the database per round trip while a file is written: the result is never held
  ROW_PAGE_SIZE: 500,
  // Exports of one store that may wait or run at once. A member who asks again while these run gets
  // a 429 instead of queueing a copy of the same personal data
  MAX_ACTIVE_PER_STORE: 3,
  // A `pending` export older than this stops counting as active: its job was lost (a worker killed mid-run)
  ACTIVE_WINDOW_MINUTES: 60,
  // A `pending` export this old will never be made (the job is gone): the cleanup marks it failed
  PENDING_GIVE_UP_HOURS: 24,
  // Rows the cleanup of expired files handles per run
  CLEANUP_BATCH: 100
} as const

// What the download tells the browser the bytes are
export const ExportContentTypes = {
  CSV: 'text/csv; charset=utf-8',
  ZIP: 'application/zip'
} as const

// A spreadsheet reads UTF-8 with accents only when the file starts with this mark
export const CSV_BOM = '﻿'
