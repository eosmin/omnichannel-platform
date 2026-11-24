import { isCleanableType } from '@platform/core/av-sanitizer'
import { AvSanitizing } from '@platform/core/storage'

// What the scan writes on a file it cleaned of its metadata. A video or an audio file may be sent only with it, so a fixture of one
// that is meant to be sendable carries it; any other kind of file needs no mark.
export const cleanedScanResult = {
  sanitized: true,
  [AvSanitizing.CLEANING_VERSION_KEY]: AvSanitizing.CLEANING_VERSION
}

export const scanResultOf = (
  contentType: string
): { scanResult: typeof cleanedScanResult } | object =>
  isCleanableType(contentType) ? { scanResult: cleanedScanResult } : {}
