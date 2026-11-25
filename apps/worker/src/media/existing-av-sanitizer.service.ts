// rls-context: every database access of this file runs inside JobContext.forStore, opened around that one call; the bucket and the cleaner are called outside of it
import { Injectable } from '@nestjs/common'
import type { Counter } from '@prometheus-io/client'
import { PinoLogger } from 'nestjs-pino'

import {
  AnyDatabaseNull,
  DatabaseNull,
  JobContext,
  JobContextGoneError,
  PrismaService
} from '@platform/core/database'
import { MediaStatus } from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import { MetricNames } from '@platform/core/metrics'
import { InjectMetric } from '@platform/core/metrics-module'
import {
  AvSanitizing,
  ExistingAvSweep,
  isEvidenceMedia,
  MediaPurpose,
  objectKeysOf,
  UploadLimits
} from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { allStoreIds } from '../schedulers/store-sweep'

import { AvCleaner } from './av-cleaner'
import { AvToolUnavailable } from './ffmpeg-av-cleaner'

// The video and audio that the cleaning of the scan (Step 7.1-J-2) never saw: they were stored before it existed, or the tools were missing
// when they came in. Same purposes as the other sweeps; a financial or fiscal file is evidence kept as it came (`isEvidenceMedia`, checked
// again on every row).
const SWEPT_PURPOSES = [
  MediaPurpose.MESSAGE,
  MediaPurpose.ORIGIN,
  MediaPurpose.PRODUCT,
  MediaPurpose.ORDER
]
const SWEPT_TYPES = Object.keys(AvSanitizing.FORMATS)

const { Outcomes } = AvSanitizing
const { ATTEMPTS_KEY, MAX_ATTEMPTS, CHANGED } = ExistingAvSweep

// The cleaner threw something that is not `AvToolUnavailable` and is not a verdict on the file (a spawn that failed for want of memory, a bug): the
// machine's fault as far as anyone can tell, so it does not count as an attempt of THAT file. Kept apart from the errors of the bucket and the
// database only to decide whether the run goes on with the next file or stops
class CleanerFailed extends Error {
  constructor(readonly original: unknown) {
    super('the video and audio cleaner failed')
  }
}

export interface ExistingAvReport {
  // Rewritten and marked
  cleaned: number
  // Kept as it came with a FINAL mark (the file's own fault, or a file that is not in the bucket)
  kept: number
  // The tools were missing: marked `av_unavailable`, taken again by the next run
  unavailable: number
  // Changed under the sweep, or passed its deadline (left with its attempt counted)
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

type Left = string

// A row the sweep has not finished with: no mark of the cleaning, which is no `scan_result` at all (stored before the cleaning) or a
// `scan_result` with no version key at all (today only the note `unavailableSince` of a scanner that was down could be there, and no writer
// leaves it on a clean video: the scan replaces the whole column with its mark; the list does not lean on that, because a video with no mark
// is not sendable and one that no key puts here would wait for ever), a try in progress or interrupted (fewer than
// MAX_ATTEMPTS), a file the tools could not be started for (`av_unavailable`, the machine's fault and not the file's: taken again on every run
// for as long as it lasts) or a mark of an older version of the cleaning. A final `not_cleanable` (the file's own fault) carries the current
// version and is never taken again. A row at MAX_ATTEMPTS is made final by `closeExhausted` BEFORE this is read.
export const TAKEN = {
  OR: [
    // A key that is not there, and a column that is null, are the same answer of the database to `equals: DbNull` on a path (measured on
    // PostgreSQL 17 with the Prisma client of the repository); a mark of ANY version carries the key, so this never takes a finished row
    {
      AND: [
        { scanResult: { path: [AvSanitizing.CLEANING_VERSION_KEY], equals: DatabaseNull } },
        // Not a row that spent its tries: `closeExhausted` makes it final (a run that overlaps may have written the last try after it ran)
        {
          OR: [
            { scanResult: { path: [ATTEMPTS_KEY], equals: DatabaseNull } },
            { scanResult: { path: [ATTEMPTS_KEY], lt: MAX_ATTEMPTS } }
          ]
        }
      ]
    },
    { scanResult: { path: [ATTEMPTS_KEY], lt: MAX_ATTEMPTS } },
    { scanResult: { path: [AvSanitizing.OUTCOME_KEY], equals: Outcomes.AV_UNAVAILABLE } },
    { scanResult: { path: [AvSanitizing.CLEANING_VERSION_KEY], lt: AvSanitizing.CLEANING_VERSION } }
  ]
}

const attemptsOf = (scanResult: unknown): number => {
  const value =
    typeof scanResult === 'object' && scanResult !== null
      ? (scanResult as Record<string, unknown>)[ATTEMPTS_KEY]
      : undefined
  return typeof value === 'number' ? value : 0
}

// The row as this run left it when it began: every write that closes the work is made only while the row still holds this number
const inProgress = (attempt: number) => ({ scanResult: { path: [ATTEMPTS_KEY], equals: attempt } })

// What a row holds when the file was kept as it came, or the tools could not start (the reason is a code, never a message)
const keptMark = (outcome: string) => ({
  [AvSanitizing.OUTCOME_KEY]: outcome,
  [AvSanitizing.CLEANING_VERSION_KEY]: AvSanitizing.CLEANING_VERSION
})

const CLEANED_MARK = {
  sanitized: true,
  [AvSanitizing.CLEANING_VERSION_KEY]: AvSanitizing.CLEANING_VERSION
}

// Runs the cleaning of metadata (`AvCleaner`: ffmpeg in a child process) over the video and audio stored before it existed, a small batch of
// each store per run, one file at a time (the cleaner runs inside the decode slot of the process). The progress is the row: no table.
// Safe to repeat and to stop at any point.
//
// The cleaner ALWAYS rewrites (it cannot tell by the content that a file is clean), so the version mark is the only thing that keeps a file
// from being copied on every run. What keeps a customer's file from being lost: the key, the row id and the URL never change; the new bytes are
// made and read back in memory (`AvCleaner`) and written over the key only if the object is still the one that was read (same ETag and size);
// a failed write leaves the original; the row is marked after the write; the sweep never runs without the versioning of the bucket in a
// deployed environment (`VersionedBucketGuard`, in the scheduler).
//
// The attempts: the number of the try is on the row BEFORE the file is opened, so a file that kills the process (memory, a deadline) is not
// taken for ever: at MAX_ATTEMPTS it ends `attempts_exhausted`, kept as it came. ONLY what kills or exhausts the process with THAT file
// counts (a process that dies leaves the number on the row; a deadline of the child is counted by hand). Everything that is the machine's fault
// does NOT add to the count: a tool that is missing marks the row `av_unavailable`, and a failure of the bucket, the database or the cleaner
// gives the try back (`release`), so an outage of any length never turns good videos into final ones, with their metadata inside (the alert on
// `av_unavailable` of Step 7.6 says so).
@Injectable()
export class ExistingAvSanitizer {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobContext: JobContext,
    private readonly storage: StorageService,
    private readonly logger: PinoLogger,
    private readonly cleaner: AvCleaner,
    @InjectMetric(MetricNames.AV_CLEANING) private readonly results: Counter<string>
  ) {
    this.logger.setContext(ExistingAvSanitizer.name)
  }

  // The schedule: every store
  async run(): Promise<ExistingAvReport> {
    return this.sweep(await allStoreIds(this.prisma))
  }

  // For a spec that shares the database and the bucket with other suites: only the stores it names, and an empty list is no store at all. No
  // route, job or payload can carry a list.
  runScoped(storeIds: readonly string[]): Promise<ExistingAvReport> {
    return this.sweep(storeIds)
  }

  private async sweep(storeIds: readonly string[]): Promise<ExistingAvReport> {
    const report: ExistingAvReport = { cleaned: 0, kept: 0, unavailable: 0, skipped: 0, failed: 0 }
    const deadline = Date.now() + ExistingAvSweep.MAX_RUN_MS
    for (const storeId of storeIds) {
      // A failure is not work done: it does not use the budget of the run, the attempts of its row bound it
      const room = ExistingAvSweep.MAX_PER_RUN - this.handled(report)
      if (room <= 0 || Date.now() >= deadline) break
      try {
        await this.closeExhausted(storeId)
        const toolsDown = await this.sweepStore(
          storeId,
          Math.min(room, ExistingAvSweep.BATCH_PER_STORE),
          report,
          deadline
        )
        // The tools are missing for every file: the run ends after the FIRST one (one object read, not twenty) and the next run asks again
        if (toolsDown) break
      } catch (error) {
        // A store that is deleted while it waits has nothing left; any other failure of a store does not stop the others
        if (error instanceof JobContextGoneError) continue
        report.failed += 1
        this.logger.error(
          { storeId, errorName: errorName(error) },
          'a store could not be swept for video and audio with metadata'
        )
      }
    }
    return report
  }

  private handled(report: ExistingAvReport): number {
    return report.cleaned + report.kept + report.unavailable + report.skipped
  }

  // A file that was tried MAX_ATTEMPTS times and never finished (the process died or passed its deadline each time) is the file's own fault:
  // final, kept as it came. Made before the batch is read, so no query has to exclude it
  private async closeExhausted(storeId: string): Promise<void> {
    const closed = await this.jobContext.forStore(storeId, () =>
      this.prisma.client.media.updateMany({
        where: {
          storeId,
          status: MediaStatus.CLEAN,
          purpose: { in: SWEPT_PURPOSES },
          contentType: { in: SWEPT_TYPES },
          scanResult: { path: [ATTEMPTS_KEY], gte: MAX_ATTEMPTS }
        },
        data: { scanResult: keptMark(ExistingAvSweep.ATTEMPTS_EXHAUSTED) }
      })
    )
    if (closed.count > 0) {
      this.results.inc({ result: Outcomes.NOT_CLEANABLE }, closed.count)
      this.logger.error(
        { storeId, count: closed.count },
        'stored video or audio files passed every attempt without finishing and were kept as they came'
      )
    }
  }

  private async sweepStore(
    storeId: string,
    take: number,
    report: ExistingAvReport,
    deadline: number
  ): Promise<boolean> {
    const rows: Candidate[] = await this.jobContext.forStore(storeId, () =>
      this.prisma.client.media.findMany({
        where: {
          storeId,
          status: MediaStatus.CLEAN,
          purpose: { in: SWEPT_PURPOSES },
          contentType: { in: SWEPT_TYPES },
          ...TAKEN
        },
        select: { id: true, key: true, contentType: true, purpose: true, scanResult: true },
        orderBy: { id: 'asc' },
        take
      })
    )
    for (const row of rows) {
      if (Date.now() >= deadline) return false
      const attempt = attemptsOf(row.scanResult) + 1
      try {
        const left = await this.sweepOne(row, storeId, attempt)
        if (left === undefined) report.cleaned += 1
        else if (left === Outcomes.AV_UNAVAILABLE) {
          report.unavailable += 1
          return true
        } else if (left === CHANGED) report.skipped += 1
        else report.kept += 1
      } catch (error) {
        // A store deleted while its batch runs has nothing left: the run skips it, as it does at the level of the store
        const cause = error instanceof CleanerFailed ? error.original : error
        if (cause instanceof JobContextGoneError) throw cause
        // Not a verdict on the file: the bucket, the database or the machine failed. The try is given back (the row goes to what the batch read), so
        // an outage of any length never turns a good file into a final one; only what kills or exhausts the process with THAT file counts
        report.failed += 1
        await this.release(row, storeId, attempt, error)
        // The bucket or the database is down: the next file would fail the same way. A failure of the cleaner alone goes on with the next file
        if (!(error instanceof CleanerFailed)) return true
      }
    }
    return false
  }

  // Undefined when the file was rewritten and marked; otherwise what was left (the reason marked, `av_unavailable`, or `changed`: left unmarked)
  private async sweepOne(
    row: Candidate,
    storeId: string,
    attempt: number
  ): Promise<Left | undefined> {
    // Evidence and any type the cleaner does not take are never read: the query does not select them, and this is the second lock on the door
    if (isEvidenceMedia(row.purpose) || !SWEPT_TYPES.includes(row.contentType)) return CHANGED
    // The attempt is counted before the file is opened: a file that kills the process never reaches a handler
    if (!(await this.begin(row.id, storeId, attempt, row.scanResult))) return CHANGED
    // Only a file under the folder of its own store is read or written: a key that is not, whatever wrote it, is left alone and marked
    if (!objectKeysOf(storeId, { key: row.key, variants: null }).keys.includes(row.key)) {
      this.logger.error(
        { mediaId: row.id, storeId },
        'a stored file names an object outside the folder of its store and was left as it is'
      )
      return this.finish(row.id, storeId, attempt, ExistingAvSweep.FOREIGN_KEY)
    }
    const seen = await this.storage.head(row.key)
    if (seen === null) {
      this.logger.warn(
        { mediaId: row.id, storeId },
        'a stored video or audio file has no object in the bucket and was left as it is'
      )
      return this.finish(row.id, storeId, attempt, ExistingAvSweep.MISSING)
    }
    // Over the limit: never read (the limit of a video, not the 10 MB of a document)
    if (seen.contentLength > UploadLimits.MAX_VIDEO_SIZE_BYTES) {
      return this.finish(row.id, storeId, attempt, AvSanitizing.Untouched.TOO_LARGE)
    }
    const original = await this.storage.read(row.key, UploadLimits.MAX_VIDEO_SIZE_BYTES)
    if (original === null) return this.finish(row.id, storeId, attempt, ExistingAvSweep.MISSING)

    let cleaned
    try {
      cleaned = await this.cleaner.clean(original, row.contentType, row.id)
    } catch (error) {
      // The tools could not be started: the machine's fault. The file keeps what it had, marked so that nothing sends it and the next run takes
      // it again; the attempt is NOT counted (the mark replaces the number)
      if (!(error instanceof AvToolUnavailable)) throw new CleanerFailed(error)
      this.logger.error(
        { mediaId: row.id, storeId },
        'the video and audio tools could not be started for a stored file'
      )
      return this.finish(row.id, storeId, attempt, Outcomes.AV_UNAVAILABLE)
    }
    if (cleaned.kind === AvSanitizing.Results.UNTOUCHED) {
      if (cleaned.why === AvSanitizing.Untouched.TIMED_OUT) {
        // The deadline killed the child with THIS file: it counts. The row keeps its number and is taken again; at MAX_ATTEMPTS it is final
        this.logger.warn(
          { mediaId: row.id, storeId, attempt },
          'a stored video or audio file passed the deadline of its cleaning and was left as it is'
        )
        if (attempt >= MAX_ATTEMPTS) {
          return this.finish(row.id, storeId, attempt, ExistingAvSweep.ATTEMPTS_EXHAUSTED)
        }
        return CHANGED
      }
      this.logger.warn(
        { mediaId: row.id, storeId, why: cleaned.why },
        'a stored video or audio file could not be cleaned and was left as it is'
      )
      return this.finish(row.id, storeId, attempt, cleaned.why)
    }

    // Only the object that was read is replaced: a change in between leaves it, and the row, as they are
    const now = await this.storage.head(row.key)
    if (now === null || now.etag !== seen.etag || now.contentLength !== seen.contentLength) {
      this.logger.warn(
        { mediaId: row.id, storeId },
        'a stored video or audio file changed while it was being cleaned and was left as it is'
      )
      return CHANGED
    }
    // The original is replaced only now, with bytes that were made and read back; a failure here leaves it in the bucket and the row unmarked
    await this.storage.put(row.key, cleaned.body, row.contentType)
    const moved = await this.jobContext.forStore(storeId, () =>
      this.prisma.client.media.updateMany({
        where: { id: row.id, storeId, status: MediaStatus.CLEAN, ...inProgress(attempt) },
        data: { fileSize: cleaned.body.length, scanResult: CLEANED_MARK }
      })
    )
    if (moved.count === 0) {
      // The row still exists as `clean` in every way the write above could not have changed it, so the object is NOT taken back (a row that
      // went is the orphan cleanup's to settle): only said, and left to the next run
      this.logger.warn(
        { mediaId: row.id, storeId },
        'the row of a cleaned video or audio file changed while its object was written'
      )
      return CHANGED
    }
    this.results.inc({ result: Outcomes.CLEANED })
    return undefined
  }

  // Writes the number of the try on the row, only while the row is as the batch read it. A mark the row already holds (`av_unavailable`) is
  // KEPT, so a file that is not sendable does not become sendable while the sweep works on it
  private async begin(
    mediaId: string,
    storeId: string,
    attempt: number,
    seen: unknown
  ): Promise<boolean> {
    // Only an object has marks to keep: a column that holds a list or a bare value (nothing writes one) is replaced by the number of the try
    const held =
      typeof seen === 'object' && seen !== null && !Array.isArray(seen)
        ? (seen as Record<string, unknown>)
        : undefined
    const began = await this.jobContext.forStore(storeId, () =>
      this.prisma.client.media.updateMany({
        where: {
          id: mediaId,
          storeId,
          status: MediaStatus.CLEAN,
          // A row read as `null` is SQL NULL or the JSON null, which the client answers alike and the list above takes both of
          scanResult: seen === null ? { equals: AnyDatabaseNull } : { equals: seen as object }
        },
        data: { scanResult: { ...held, [ATTEMPTS_KEY]: attempt } }
      })
    )
    return began.count > 0
  }

  // Closes the work on a file that was not rewritten: the row holds the reason and the version, and the number of the try goes. Only while the
  // row still holds this try
  private async finish(
    mediaId: string,
    storeId: string,
    attempt: number,
    outcome: string
  ): Promise<string> {
    await this.jobContext.forStore(storeId, () =>
      this.prisma.client.media.updateMany({
        where: { id: mediaId, storeId, status: MediaStatus.CLEAN, ...inProgress(attempt) },
        data: { scanResult: keptMark(outcome) }
      })
    )
    // Counts what the run did with a file, as the scan does: `not_cleanable` for every reason that is the file's own
    if (outcome === Outcomes.AV_UNAVAILABLE) this.results.inc({ result: Outcomes.AV_UNAVAILABLE })
    else this.results.inc({ result: Outcomes.NOT_CLEANABLE })
    return outcome
  }

  // Gives back the try of a file that failed for a reason that is not its own: the row holds again what the batch read, only while it still holds
  // this try. If the write fails too (the database is the thing that is down) the number stays, which costs one try of one file per run
  private async release(
    row: Candidate,
    storeId: string,
    attempt: number,
    error: unknown
  ): Promise<void> {
    this.logger.error(
      {
        mediaId: row.id,
        storeId,
        errorName: errorName(error instanceof CleanerFailed ? error.original : error)
      },
      'a stored video or audio file could not be cleaned for a reason that is not its own; the next run tries again'
    )
    try {
      await this.jobContext.forStore(storeId, () =>
        this.prisma.client.media.updateMany({
          where: { id: row.id, storeId, status: MediaStatus.CLEAN, ...inProgress(attempt) },
          data: { scanResult: row.scanResult === null ? DatabaseNull : (row.scanResult as object) }
        })
      )
    } catch (writeError) {
      this.logger.error(
        { mediaId: row.id, storeId, errorName: errorName(writeError) },
        'the try of a stored video or audio file could not be given back'
      )
    }
  }
}
