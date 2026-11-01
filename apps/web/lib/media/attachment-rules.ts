import { type ErrorCode, ErrorCodes } from '@platform/core/errors'
import {
  AllowedContentTypes,
  mediaMessageTypeOf,
  type OutboundMediaType,
  refuseUpload,
  UploadRefusals
} from '@platform/core/storage'

// What the picker offers: the allowed types and nothing else (the api checks them again)
export const ATTACHMENT_ACCEPT = Object.values(AllowedContentTypes).flat().join(',')

export type AttachmentRefusal = 'empty' | typeof UploadRefusals.TYPE_NOT_ALLOWED | 'too_large'

// Why a file cannot be sent, before any byte leaves the browser. The type is the one the browser
// declares, as the api reads it; a file with no declared type is refused like any other type.
export function refuseAttachment(file: { type: string; size: number }): AttachmentRefusal | null {
  if (file.size === 0) return 'empty'
  return refuseUpload(file.type, file.size)
}

// The message type a file is sent as, or null when it is not an allowed type
export function attachmentMessageType(contentType: string): OutboundMediaType | null {
  return mediaMessageTypeOf(contentType)
}

const UNITS = ['B', 'KB', 'MB', 'GB'] as const

// 1536 -> "1.5 KB". Plain numbers: the unit symbols are the same in every language.
export function formatBytes(bytes: number): string {
  let value = bytes
  let unit = 0
  // Promote on the rounded value, or 1048575 bytes would read "1024 KB"
  while (Math.round(value * 10) / 10 >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const text = unit === 0 || value >= 10 ? Math.round(value).toString() : value.toFixed(1)
  return `${text} ${UNITS[unit]}`
}

// The error code the interface shows for a refusal (the same ones the api answers with)
export function refusalCode(refusal: AttachmentRefusal): ErrorCode {
  if (refusal === UploadRefusals.TYPE_NOT_ALLOWED) return ErrorCodes.FILE_TYPE_NOT_ALLOWED
  return refusal === 'too_large' ? ErrorCodes.FILE_TOO_LARGE : ErrorCodes.FILE_UPLOAD_FAILED
}
