// rls-context: every database access of this file runs inside JobContext.forStore, opened around that one call; the bucket and the cleaner are called outside of it
import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import {
  DatabaseNull,
  JobContext,
  JobContextGoneError,
  PrismaService
} from '@platform/core/database'
import { isSanitizedDocumentType } from '@platform/core/document-sanitizer'
import { MediaStatus } from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import {
  DocumentSanitizing,
  ExistingDocumentSweep,
  ExistingPictureSweep,
  isEvidenceMedia,
  MediaPurpose,
  objectKeysOf,
  UploadLimits
} from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { allStoreIds } from '../schedulers/store-sweep'

import { DocumentCleaner } from './document-cleaner'

// The documents that the cleaning of `Step 7.1-I` never saw: they were stored before it existed. Their purposes are the ones the scan
// cleans for pictures; a financial or fiscal file is evidence that is kept as it came and is never taken (`isEvidenceMedia`, checked again
// on every row, so a purpose added to the list of evidence later cannot be rewritten by a sweep that forgot it).
const SWEPT_PURPOSES = [
  MediaPurpose.MESSAGE,
  MediaPurpose.ORIGIN,
  MediaPurpose.PRODUCT,
  MediaPurpose.ORDER
]
const SWEPT_TYPES = [
  DocumentSanitizing.PDF_CONTENT_TYPE,
  DocumentSanitizing.DOCX_CONTENT_TYPE,
  DocumentSanitizing.XLSX_CONTENT_TYPE
]

export interface ExistingDocumentReport {
  cleaned: number
  alreadyClean: number
  skipped: number
  failed: number
}

interface Candidate {
  id: string
  key: string
  contentType: string
  purpose: string
  scanResult: unknown
}

// What a sweep did with a document besides rewriting it: the outcome it marked, or that the document changed under it and was left unmarked
type Left =
  | (typeof ExistingDocumentSweep.Outcomes)[keyof typeof ExistingDocumentSweep.Outcomes]
  | typeof ExistingDocumentSweep.CHANGED

// A row the sweep has not finished with: no `scan_result` at all (stored before the cleaning existed, or kept as it came by the scan because it
// could not be cleaned), or one that failed fewer than MAX_ATTEMPTS times. The same condition guards every write, so a row that another
// writer moved on is never overwritten.
const NOT_FINISHED = {
  OR: [
    { scanResult: { equals: DatabaseNull } },
    {
      scanResult: {
        path: [ExistingPictureSweep.ATTEMPTS_KEY],
        lt: ExistingDocumentSweep.MAX_ATTEMPTS
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

// The row as this run left it when it began to work on the document: its attempt number is on the row before the file is opened, and every
// write that closes the work (the mark, the new size, the failure) is made only while the row still holds that number
const inProgress = (attempt: number) => ({
  scanResult: { path: [ExistingPictureSweep.ATTEMPTS_KEY], equals: attempt }
})

// Runs the cleaning of properties (`sanitizeDocument`) over the PDF, docx and xlsx stored before it existed, a bounded batch of each store per
// run, one document at a time (the cleaner parses it whole inside the decode slot of the process). The progress is the row, as for pictures:
// a document that was cleaned carries `scanResult.sanitized` and one that was looked at and left as it is carries `scanResult.sanitizeSweep`.
// Safe to repeat, and to stop at any point.
//
// What keeps a customer's file from being lost: the key, the row id and the URL never change; the cleaned bytes are made and read back in
// memory (`sanitizeDocument` loads them again and compares what the customer sees: bookmarks, annotations, every part) and written over the key
// only if the object is still the one that was read (same ETag and size); an overwrite in the bucket is atomic, so a failed write leaves the
// original, and the row is marked after the write. A crash between the two leaves a file that carries nothing and a row with no mark: the next
// run finds it already clean and only writes the mark. A document that cannot be cleaned without risk (encrypted, signed, damaged, too big
// once opened) is left as it is and marked, never deleted and never refused: it was served. The sweep never runs without the versioning of
// the bucket in a deployed environment (`VersionedBucketGuard`, in the scheduler): the original cannot be recovered otherwise.
@Injectable()
export class ExistingDocumentSanitizer {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobContext: JobContext,
    private readonly storage: StorageService,
    private readonly logger: PinoLogger,
    private readonly documents: DocumentCleaner
  ) {
    this.logger.setContext(ExistingDocumentSanitizer.name)
  }

  // The schedule: every store
  async run(): Promise<ExistingDocumentReport> {
    return this.sweep(await allStoreIds(this.prisma))
  }

  // For a spec that shares the database and the bucket with other suites: only the stores it names, and an empty list is no store at all,
  // never every store. No route, job or payload can carry a list.
  runScoped(storeIds: readonly string[]): Promise<ExistingDocumentReport> {
    return this.sweep(storeIds)
  }

  private async sweep(storeIds: readonly string[]): Promise<ExistingDocumentReport> {
    const report: ExistingDocumentReport = { cleaned: 0, alreadyClean: 0, skipped: 0, failed: 0 }
    const deadline = Date.now() + ExistingDocumentSweep.MAX_RUN_MS
    for (const storeId of storeIds) {
      // A failure is not work done: it does not use the budget of the run, the attempts of its row bound it
      const room = ExistingDocumentSweep.MAX_PER_RUN - this.handled(report)
      if (room <= 0 || Date.now() >= deadline) break
      try {
        await this.sweepStore(
          storeId,
          Math.min(room, ExistingDocumentSweep.BATCH_PER_STORE),
          report,
          deadline
        )
      } catch (error) {
        // A store that is deleted while it waits has nothing left; any other failure of a store does not stop the others
        if (error instanceof JobContextGoneError) continue
        report.failed += 1
        this.logger.error(
          { storeId, errorName: errorName(error) },
          'a store could not be swept for documents with properties'
        )
      }
    }
    return report
  }

  private handled(report: ExistingDocumentReport): number {
    return report.cleaned + report.alreadyClean + report.skipped
  }

  private async sweepStore(
    storeId: string,
    take: number,
    report: ExistingDocumentReport,
    deadline: number
  ): Promise<void> {
    const rows: Candidate[] = await this.jobContext.forStore(storeId, () =>
      this.prisma.client.media.findMany({
        where: {
          storeId,
          status: MediaStatus.CLEAN,
          purpose: { in: SWEPT_PURPOSES },
          contentType: { in: SWEPT_TYPES },
          ...NOT_FINISHED
        },
        select: { id: true, key: true, contentType: true, purpose: true, scanResult: true },
        orderBy: { id: 'asc' },
        take
      })
    )
    for (const row of rows) {
      if (Date.now() >= deadline) return
      const attempt = attemptsOf(row.scanResult) + 1
      try {
        const left = await this.sweepOne(row, storeId, attempt)
        if (left === undefined) report.cleaned += 1
        else if (left === ExistingDocumentSweep.Outcomes.ALREADY_CLEAN) report.alreadyClean += 1
        else report.skipped += 1
      } catch (error) {
        report.failed += 1
        await this.recordFailure(row, storeId, attempt, error)
      }
    }
  }

  // Undefined when the document was rewritten and marked; otherwise what was left (the outcome marked, or `changed`: left unmarked)
  private async sweepOne(
    row: Candidate,
    storeId: string,
    attempt: number
  ): Promise<Left | undefined> {
    // Evidence and any type the cleaner does not take are never read: the query does not select them, and this is the second lock on the door
    if (isEvidenceMedia(row.purpose) || !isSanitizedDocumentType(row.contentType)) {
      return ExistingDocumentSweep.CHANGED
    }
    // The attempt is counted before the file is opened: a document that hangs or brings the process down never reaches a handler, and
    // without this it would be taken again every ten minutes for ever. After MAX_ATTEMPTS it is not taken again (see the plan)
    if (!(await this.begin(row.id, storeId, attempt, row.scanResult))) {
      return ExistingDocumentSweep.CHANGED
    }
    // Only a file under the folder of its own store is read, written or deleted (as `objectKeysOf` does for the deletions): a key that is
    // not, whatever wrote it, is left alone and marked
    if (!objectKeysOf(storeId, { key: row.key, variants: null }).keys.includes(row.key)) {
      this.logger.error(
        { mediaId: row.id, storeId },
        'a stored document names a file outside the folder of its store and was left as it is'
      )
      return this.mark(row.id, storeId, ExistingDocumentSweep.Outcomes.FOREIGN_KEY, attempt)
    }
    const seen = await this.storage.head(row.key)
    const original =
      seen === null ? null : await this.storage.read(row.key, UploadLimits.MAX_FILE_SIZE_BYTES)
    if (seen === null || original === null) {
      this.logger.warn(
        { mediaId: row.id, storeId },
        'a stored document has no file in the bucket and was left as it is'
      )
      return this.mark(row.id, storeId, ExistingDocumentSweep.Outcomes.MISSING, attempt)
    }
    // An error of the machine propagates: it is a failure to try again, never a mark
    const cleaned = await this.documents.clean(original, row.contentType)
    if (cleaned.kind === 'untouched') {
      if (cleaned.why === ExistingDocumentSweep.Outcomes.ALREADY_CLEAN) {
        // A crash between the write and the mark, or a document that never carried anything: only the mark is written
        return this.mark(
          row.id,
          storeId,
          ExistingDocumentSweep.Outcomes.ALREADY_CLEAN,
          attempt,
          original.length
        )
      }
      this.logger.warn(
        { mediaId: row.id, storeId, why: cleaned.why },
        'a stored document could not be cleaned of its properties and was left as it is'
      )
      return this.mark(row.id, storeId, ExistingDocumentSweep.Outcomes.NOT_CLEANABLE, attempt)
    }

    // Only the object that was read is replaced: a change in between leaves it, and the row, as they are
    const now = await this.storage.head(row.key)
    if (now === null || now.etag !== seen.etag || now.contentLength !== seen.contentLength) {
      this.logger.warn(
        { mediaId: row.id, storeId },
        'a stored document changed while it was being cleaned and was left as it is'
      )
      return ExistingDocumentSweep.CHANGED
    }
    // The original is replaced only now, with bytes that were produced and read back; a failure here leaves it in the bucket and the row unmarked
    await this.storage.put(row.key, cleaned.body, row.contentType)
    const moved = await this.jobContext.forStore(storeId, () =>
      this.prisma.client.media.updateMany({
        where: { id: row.id, storeId, status: MediaStatus.CLEAN, ...inProgress(attempt) },
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
        'the row of a cleaned document changed or went while its file was written'
      )
      await this.takeBackIfRowGone(row.id, row.key, storeId)
      return ExistingDocumentSweep.CHANGED
    }
    return undefined
  }

  // Writes the attempt number on the row, only while the row is as the batch read it (not finished): false when another writer moved it on. The
  // number stays on the row until the work ends (the mark, the new size or the failure replace it), so a process that dies in between has
  // used one of its MAX_ATTEMPTS, and a row at MAX_ATTEMPTS is not taken by the query again.
  private async begin(
    mediaId: string,
    storeId: string,
    attempt: number,
    seen: unknown
  ): Promise<boolean> {
    const began = await this.jobContext.forStore(storeId, () =>
      this.prisma.client.media.updateMany({
        where: {
          id: mediaId,
          storeId,
          status: MediaStatus.CLEAN,
          ...(seen === null ? { scanResult: { equals: DatabaseNull } } : inProgress(attempt - 1))
        },
        data: { scanResult: { [ExistingPictureSweep.ATTEMPTS_KEY]: attempt } }
      })
    )
    return began.count > 0
  }

  // The write is not atomic with the check of the ETag (Step 7.3): if the row was deleted (a conversation or a customer erased) while the file
  // was written, the write brought back a file that should be gone, so it is removed. A row that still exists is left with its file.
  private async takeBackIfRowGone(mediaId: string, key: string, storeId: string): Promise<void> {
    const still = await this.jobContext.forStore(storeId, () =>
      this.prisma.client.media.findFirst({ where: { id: mediaId, storeId }, select: { id: true } })
    )
    if (still === null) await this.storage.delete(key)
  }

  // Counts a failure on the row; at MAX_ATTEMPTS it ends as `failed` (logged at error level) and the sweep stops taking it
  private async recordFailure(
    row: Candidate,
    storeId: string,
    attempts: number,
    error: unknown
  ): Promise<void> {
    const last = attempts >= ExistingDocumentSweep.MAX_ATTEMPTS
    this.logger.error(
      { mediaId: row.id, storeId, attempts, last, errorName: errorName(error) },
      last
        ? 'a stored document could not be cleaned and was given up'
        : 'a stored document could not be cleaned; the next run tries again'
    )
    try {
      await this.jobContext.forStore(storeId, () =>
        this.prisma.client.media.updateMany({
          where: { id: row.id, storeId, status: MediaStatus.CLEAN, ...inProgress(attempts) },
          data: {
            scanResult: {
              [ExistingPictureSweep.ATTEMPTS_KEY]: attempts,
              ...(last
                ? {
                    [ExistingPictureSweep.OUTCOME_KEY]: ExistingDocumentSweep.Outcomes.FAILED
                  }
                : {})
            }
          }
        })
      )
    } catch (writeError) {
      // The count is a bound, not the data: if it cannot be written the row is tried again, as it would be without one
      this.logger.error(
        { mediaId: row.id, storeId, errorName: errorName(writeError) },
        'the failure of a stored document could not be recorded'
      )
    }
  }

  // Writes the outcome of a document that was not rewritten, only while the row is not finished: a mark never replaces another one
  private async mark(
    mediaId: string,
    storeId: string,
    outcome: Left,
    attempt: number,
    fileSize?: number
  ): Promise<Left> {
    await this.jobContext.forStore(storeId, () =>
      this.prisma.client.media.updateMany({
        where: { id: mediaId, storeId, status: MediaStatus.CLEAN, ...inProgress(attempt) },
        data: {
          // A file that a crash left cleaned: the row learns its true size, as the scan does on its retry
          ...(fileSize === undefined ? {} : { fileSize }),
          scanResult:
            outcome === ExistingDocumentSweep.Outcomes.ALREADY_CLEAN
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
