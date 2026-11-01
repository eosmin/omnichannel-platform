// What a store of objects calls a file whose type it does not know
export const GENERIC_CONTENT_TYPE = 'application/octet-stream'

// The window of the counters of signed urls: one hour, and a counter outlives its window by one more
export const QUOTA_WINDOW_MS = 3_600_000

export const UploadLimits = {
  MAX_FILE_SIZE_BYTES: 10 * 1024 * 1024, // 10 MB
  MAX_VIDEO_SIZE_BYTES: 25 * 1024 * 1024, // 25 MB
  PRESIGNED_URL_TTL_SECONDS: 300, // 5 min
  DOWNLOAD_URL_TTL_SECONDS: 900, // 15 min
  UNCONFIRMED_UPLOAD_TTL_HOURS: 24, // Orphan objects without a Media row are deleted by cleanup
  // Signed upload urls a store and one of its members may ask for per hour. `upload-url` writes
  // nothing, so without a cap a member fills the bucket with files that are never confirmed.
  SIGNED_URLS_PER_STORE_PER_HOUR: 300,
  SIGNED_URLS_PER_USER_PER_HOUR: 100,
  // How long the api remembers who asked for a signed url: only that user may confirm it
  PENDING_UPLOAD_TTL_SECONDS: 24 * 60 * 60,
  // Objects and rows the cleanup looks at per run, oldest first (a full run is logged)
  ORPHAN_CLEANUP_BATCH: 500,
  // Pages of 1000 objects the cleanup lists per run; it resumes where it stopped on the next one
  ORPHAN_LIST_PAGES_PER_RUN: 30,
  // An infected row is checked for a leftover file only for this long after its verdict
  INFECTED_CLEANUP_WINDOW_HOURS: 72,
  // The whole fetch of a file a customer sent: asking the provider and reading the body
  INBOUND_FETCH_TIMEOUT_MS: 60_000,
  // A row still `pending` after this long was never scanned (its job was lost): the scan is queued again
  STUCK_SCAN_MINUTES: 30
} as const

export const AllowedContentTypes = {
  IMAGE: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  VIDEO: ['video/mp4', 'video/quicktime'],
  AUDIO: ['audio/mpeg', 'audio/ogg', 'audio/wav'],
  DOCUMENT: [
    'application/pdf',
    'text/plain',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
} as const

export const AllAllowedContentTypes: ReadonlySet<string> = new Set(
  Object.values(AllowedContentTypes).flat()
)
