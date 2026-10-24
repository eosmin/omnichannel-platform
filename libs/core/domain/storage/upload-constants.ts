export const UploadLimits = {
  MAX_FILE_SIZE_BYTES: 10 * 1024 * 1024, // 10 MB
  MAX_VIDEO_SIZE_BYTES: 25 * 1024 * 1024, // 25 MB
  PRESIGNED_URL_TTL_SECONDS: 300, // 5 min
  DOWNLOAD_URL_TTL_SECONDS: 900, // 15 min
  UNCONFIRMED_UPLOAD_TTL_HOURS: 24 // Orphan objects without a Media row are deleted by cleanup
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
