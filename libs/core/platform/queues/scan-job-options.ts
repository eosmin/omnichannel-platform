import { JobNames } from './queue-names'

// The retry policy of the scan of a file. It waits for the antivirus: 8 tries, 5 s doubling (5 + 10 + ... + 320 s), so about ten minutes in
// all. A scanner that is restarted or down for a few minutes does not end the job; past that the file stays pending, never served, and the
// sweep of stuck scans queues the scan again (a file is given up only after the scanner has failed for `UploadLimits.SCAN_GIVE_UP_HOURS`). The other
// jobs of the heavy queue keep the queue's own two tries: a failing bulk run is not asked again eight times.
export const ScanFileRetry = {
  ATTEMPTS: 8,
  BACKOFF_MS: 5000
} as const

// The options of every producer of a `SCAN_FILE` job: one job per file, with the retry above
export function scanFileJobOptions(mediaId: string): {
  jobId: string
  attempts: number
  backoff: { type: 'exponential'; delay: number }
} {
  return {
    jobId: `${JobNames.SCAN_FILE}-${mediaId}`,
    attempts: ScanFileRetry.ATTEMPTS,
    backoff: { type: 'exponential', delay: ScanFileRetry.BACKOFF_MS }
  }
}
