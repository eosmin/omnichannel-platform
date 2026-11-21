// rls-context: every database access of this file runs inside JobContext.forStore, opened around that one call; the bucket and the encoder are called outside of it
import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'
import sharp, { type Metadata } from 'sharp'

import {
  DatabaseNull,
  JobContext,
  JobContextGoneError,
  PrismaService
} from '@platform/core/database'
import { MediaStatus } from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import {
  carriesMetadata,
  ImageNotSanitizable,
  isEnvironmentError,
  isSanitizedType,
  sanitizeImage
} from '@platform/core/image-sanitizer'
import {
  ExistingPictureSweep,
  ImageSanitizing,
  MediaPurpose,
  UploadLimits
} from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { allStoreIds } from '../schedulers/store-sweep'

// The pictures that the cleaning of `TDD_07 §6.5` never saw: they were stored before it existed. Their purposes are the ones the scan
// cleans (an avatar has its own processing, and a financial or fiscal file is evidence that is kept as it came).
const SWEPT_PURPOSES = [
  MediaPurpose.MESSAGE,
  MediaPurpose.ORIGIN,
  MediaPurpose.PRODUCT,
  MediaPurpose.ORDER
]

export interface ExistingPictureReport {
  cleaned: number
  alreadyClean: number
  skipped: number
  failed: number
}

interface Candidate {
  id: string
  key: string
  contentType: string
  scanResult: unknown
}

// What a sweep did with a picture besides rewriting it: the outcome it marked, or that the picture changed under it and was left unmarked
type Left =
  (typeof ExistingPictureSweep.Outcomes)[keyof typeof ExistingPictureSweep.Outcomes] | 'changed'

// A row the sweep has not finished with: no `scan_result` at all (stored before the cleaning existed), or one that failed fewer than
// MAX_ATTEMPTS times. The same condition guards every write, so a row that another writer moved on is never overwritten.
const NOT_FINISHED = {
  OR: [
    { scanResult: { equals: DatabaseNull } },
    {
      scanResult: {
        path: [ExistingPictureSweep.ATTEMPTS_KEY],
        lt: ExistingPictureSweep.MAX_ATTEMPTS
      }
    }
  ]
}

const attemptsOf = (scanResult: unknown): number => {
  const value =
    typeof scanResult === 'object' && scanResult !== null
      ? (scanResult as Record<string, unknown>)[ExistingPictureSweep.ATTEMPTS_KEY]
      : undefined
  return typeof value === 'number' ? value : 0
}

// Runs the cleaning of metadata over the pictures stored before it existed, a bounded batch of each store per run. The progress is the
// row: a picture that was cleaned carries `scanResult.sanitized` (as the scan writes it) and one that was looked at and left as it is
// carries `scanResult.sanitizeSweep`, so a row with no `scanResult` is one that has not been seen. Safe to repeat, and to stop at any point.
//
// What keeps a customer's file from being lost: the key, the row id and the URL never change; the cleaned bytes are written over the key
// only after they were produced and checked in memory (the output holds no metadata and has the same pixels count), and only if the object
// is still the one that was read (same ETag); an overwrite in the bucket is atomic, so if it fails the original is still there; and the row
// is marked after the write. A crash between the two leaves a file with no metadata and a row with no mark: the next run sees that the file
// carries nothing to remove and only writes the mark, instead of encoding it a second time. A picture that cannot be decoded or cleaned is
// left as it is and logged, never deleted: it was served as clean. A re-encoded JPEG is lossy at the quality of the cleaning (the price of
// the cleaning, the same as for a new upload); the way back is the versioning of the bucket, if it is on (`inspectProtection`).
@Injectable()
export class ExistingPictureSanitizer {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobContext: JobContext,
    private readonly storage: StorageService,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(ExistingPictureSanitizer.name)
  }

  // The schedule: every store
  async run(): Promise<ExistingPictureReport> {
    return this.sweep(await allStoreIds(this.prisma))
  }

  // For a spec that shares the database and the bucket with other suites: only the stores it names, and an empty list is no store at all,
  // never every store. No route, job or payload can carry a list.
  runScoped(storeIds: readonly string[]): Promise<ExistingPictureReport> {
    return this.sweep(storeIds)
  }

  private async sweep(storeIds: readonly string[]): Promise<ExistingPictureReport> {
    const report: ExistingPictureReport = { cleaned: 0, alreadyClean: 0, skipped: 0, failed: 0 }
    const deadline = Date.now() + ExistingPictureSweep.MAX_RUN_MS
    for (const storeId of storeIds) {
      // A failure is not work done: it does not use the budget of the run, the attempts of its row bound it
      const room = ExistingPictureSweep.MAX_PER_RUN - this.handled(report)
      if (room <= 0 || Date.now() >= deadline) break
      try {
        await this.sweepStore(
          storeId,
          Math.min(room, ExistingPictureSweep.BATCH_PER_STORE),
          report,
          deadline
        )
      } catch (error) {
        // A store that is deleted while it waits has nothing left; any other failure of a store does not stop the others
        if (error instanceof JobContextGoneError) continue
        report.failed += 1
        this.logger.error(
          { storeId, errorName: errorName(error) },
          'a store could not be swept for pictures with metadata'
        )
      }
    }
    return report
  }

  private handled(report: ExistingPictureReport): number {
    return report.cleaned + report.alreadyClean + report.skipped
  }

  private async sweepStore(
    storeId: string,
    take: number,
    report: ExistingPictureReport,
    deadline: number
  ): Promise<void> {
    const rows: Candidate[] = await this.jobContext.forStore(storeId, () =>
      this.prisma.client.media.findMany({
        where: {
          storeId,
          status: MediaStatus.CLEAN,
          purpose: { in: SWEPT_PURPOSES },
          contentType: { in: [...ImageSanitizing.CONTENT_TYPES] },
          ...NOT_FINISHED
        },
        select: { id: true, key: true, contentType: true, scanResult: true },
        orderBy: { id: 'asc' },
        take
      })
    )
    for (const row of rows) {
      if (Date.now() >= deadline) return
      try {
        const left = await this.sweepOne(row, storeId)
        if (left === undefined) report.cleaned += 1
        else if (left === ExistingPictureSweep.Outcomes.ALREADY_CLEAN) report.alreadyClean += 1
        else report.skipped += 1
      } catch (error) {
        report.failed += 1
        await this.recordFailure(row, storeId, error)
      }
    }
  }

  // Undefined when the picture was rewritten and marked; otherwise what was left (the outcome marked, or `changed`: left unmarked)
  private async sweepOne(row: Candidate, storeId: string): Promise<Left | undefined> {
    if (!isSanitizedType(row.contentType)) {
      return this.mark(row.id, storeId, ExistingPictureSweep.Outcomes.UNTOUCHED)
    }
    const seen = await this.storage.head(row.key)
    const original =
      seen === null ? null : await this.storage.read(row.key, UploadLimits.MAX_FILE_SIZE_BYTES)
    if (seen === null || original === null) {
      this.logger.warn(
        { mediaId: row.id, storeId },
        'a stored picture has no file in the bucket and was left as it is'
      )
      return this.mark(row.id, storeId, ExistingPictureSweep.Outcomes.MISSING)
    }
    let carries: boolean
    try {
      carries = await carriesMetadata(original)
    } catch (error) {
      // An error of the machine is not the picture's: it is a failure to try again, never a mark
      if (isEnvironmentError(error)) throw error
      return this.leave(row, storeId, ExistingPictureSweep.Outcomes.UNDECODABLE, error)
    }
    if (!carries) return this.mark(row.id, storeId, ExistingPictureSweep.Outcomes.ALREADY_CLEAN)

    let cleaned
    try {
      cleaned = await sanitizeImage(original, row.contentType)
    } catch (error) {
      if (!(error instanceof ImageNotSanitizable)) throw error
      return this.leave(row, storeId, ExistingPictureSweep.Outcomes.NOT_CLEANABLE, error.reason)
    }
    if (cleaned.kind === 'untouched') {
      return this.mark(row.id, storeId, ExistingPictureSweep.Outcomes.UNTOUCHED)
    }
    await this.assertSamePixels(original, cleaned.body)

    // Only the object that was read is replaced: a change in between leaves it, and the row, as they are
    const now = await this.storage.head(row.key)
    if (now === null || now.etag !== seen.etag || now.contentLength !== seen.contentLength) {
      this.logger.warn(
        { mediaId: row.id, storeId },
        'a stored picture changed while it was being cleaned and was left as it is'
      )
      return 'changed'
    }
    // The original is replaced only now, with bytes that were produced and checked; a failure here leaves it in the bucket and the row unmarked
    await this.storage.put(row.key, cleaned.body, row.contentType)
    const moved = await this.jobContext.forStore(storeId, () =>
      this.prisma.client.media.updateMany({
        where: { id: row.id, storeId, status: MediaStatus.CLEAN, ...NOT_FINISHED },
        data: {
          fileSize: cleaned.body.length,
          scanResult: { [ExistingPictureSweep.CLEANED_KEY]: true }
        }
      })
    )
    if (moved.count === 0) {
      // The row was deleted or moved on while the file was written: nothing to mark, and nothing here will look at it again
      this.logger.warn(
        { mediaId: row.id, storeId },
        'the row of a cleaned picture changed or went while its file was written'
      )
      return 'changed'
    }
    return undefined
  }

  // The cleaned picture must be the same picture: a turn keeps the number of pixels
  private async assertSamePixels(original: Buffer, cleaned: Buffer): Promise<void> {
    const [before, after] = await Promise.all([
      sharp(original).metadata(),
      sharp(cleaned).metadata()
    ])
    const pixels = (header: Metadata): number => (header.width ?? 0) * (header.height ?? 0)
    if (pixels(before) === 0 || pixels(before) !== pixels(after)) {
      throw new Error('the cleaned picture does not have the size of the original')
    }
  }

  private leave(row: Candidate, storeId: string, outcome: Left, reason: unknown): Promise<Left> {
    this.logger.warn(
      { mediaId: row.id, storeId, outcome, reason: reasonOf(reason) },
      'a stored picture was left as it is, with its metadata'
    )
    return this.mark(row.id, storeId, outcome)
  }

  // Counts a failure on the row; at MAX_ATTEMPTS it ends as `failed` (logged at error level) and the sweep stops taking it
  private async recordFailure(row: Candidate, storeId: string, error: unknown): Promise<void> {
    const attempts = attemptsOf(row.scanResult) + 1
    const last = attempts >= ExistingPictureSweep.MAX_ATTEMPTS
    this.logger.error(
      { mediaId: row.id, storeId, attempts, last, errorName: errorName(error) },
      last
        ? 'a stored picture could not be cleaned and was given up'
        : 'a stored picture could not be cleaned; the next run tries again'
    )
    try {
      await this.jobContext.forStore(storeId, () =>
        this.prisma.client.media.updateMany({
          where: { id: row.id, storeId, status: MediaStatus.CLEAN, ...NOT_FINISHED },
          data: {
            scanResult: {
              [ExistingPictureSweep.ATTEMPTS_KEY]: attempts,
              ...(last
                ? { [ExistingPictureSweep.OUTCOME_KEY]: ExistingPictureSweep.Outcomes.FAILED }
                : {})
            }
          }
        })
      )
    } catch (writeError) {
      // The count is a bound, not the data: if it cannot be written the row is tried again, as it would be without one
      this.logger.error(
        { mediaId: row.id, storeId, errorName: errorName(writeError) },
        'the failure of a stored picture could not be recorded'
      )
    }
  }

  // Writes the outcome of a picture that was not rewritten, only while the row is not finished: a mark never replaces another one
  private async mark(mediaId: string, storeId: string, outcome: Left): Promise<Left> {
    await this.jobContext.forStore(storeId, () =>
      this.prisma.client.media.updateMany({
        where: { id: mediaId, storeId, status: MediaStatus.CLEAN, ...NOT_FINISHED },
        data: {
          scanResult:
            outcome === ExistingPictureSweep.Outcomes.ALREADY_CLEAN
              ? {
                  [ExistingPictureSweep.CLEANED_KEY]: true,
                  [ExistingPictureSweep.OUTCOME_KEY]: outcome
                }
              : { [ExistingPictureSweep.OUTCOME_KEY]: outcome }
        }
      })
    )
    return outcome
  }
}

const reasonOf = (reason: unknown): string =>
  typeof reason === 'string' ? reason : errorName(reason)
