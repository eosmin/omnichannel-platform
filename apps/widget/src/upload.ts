import { WidgetLimits } from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import {
  AllowedContentTypes,
  maxBytesFor,
  refuseUpload,
  UploadRefusals
} from '@platform/core/storage'

// PUTs the bytes to the signed url. fetch has no upload progress, so this is XHR. The one header is the
// type the url was signed for; no cookies of the site go along (the url is the permission).
export function putFile(
  url: string,
  file: Blob,
  contentType: string,
  onProgress: (fraction: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.upload.onprogress = event => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total)
    }
    request.timeout = WidgetLimits.UPLOAD_TIMEOUT_MS
    request.ontimeout = () => reject(new Error('the upload timed out'))
    request.onabort = () => reject(new Error('the upload was aborted'))
    request.onload = () => {
      if (request.status === HttpStatusCodes.OK) resolve()
      else reject(new Error(`the bucket answered ${request.status}`))
    }
    request.onerror = () => reject(new Error('the upload failed'))
    request.open('PUT', url)
    request.setRequestHeader('content-type', contentType)
    request.send(file)
  })
}

export type FileRefusal = 'empty' | 'type' | 'size'

// Why a file cannot be sent, before any byte leaves the browser: the rule of the api (`refuseUpload`),
// which checks it again. The type is the one the browser declares, as the api reads it.
export function refuseFile(file: { type: string; size: number }): FileRefusal | null {
  if (file.size === 0) return 'empty'
  const refused = refuseUpload(file.type, file.size)
  if (refused === UploadRefusals.TYPE_NOT_ALLOWED) return 'type'
  return refused === UploadRefusals.TOO_LARGE ? 'size' : null
}

// What the picker offers: the allowed types and nothing else
export const FILE_ACCEPT = Object.values(AllowedContentTypes).flat().join(',')

export { maxBytesFor }

const UNITS = ['B', 'KB', 'MB'] as const

// 1536 -> "1.5 KB". The unit symbols are the same in every language.
export function formatBytes(bytes: number): string {
  let value = bytes
  let unit = 0
  while (Math.round(value * 10) / 10 >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const text = unit === 0 || value >= 10 ? Math.round(value).toString() : value.toFixed(1)
  return `${text} ${UNITS[unit]}`
}
