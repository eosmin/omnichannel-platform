import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { Transform, Writable } from 'node:stream'
import { createInterface } from 'node:readline'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'

import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { AuditColdExport, auditColdExportLockKey } from '@platform/core/compliance'
import { PrismaService } from '@platform/core/database'
import { DAY_MS } from '@platform/core/domain'
import { StorageKeys } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { startOfNextUtcMonth, startOfUtcMonth } from './retention-clock'

export interface AuditColdExportReport {
  months: { year: number; month: number; rows: number; key: string }[]
  // True when months past the window are left for the next run
  more: boolean
  // The month another run held the lock of, when this one met it: it is left to that run and the loop stops here
  busy: { year: number; month: number } | null
}

const NEWLINE = 0x0a

// The cold export of the audit log (TDD_05 §9.3, monthly): every entry of a calendar month that is entirely past the
// hot window (two years) goes to the bucket as a gzipped JSON lines file, the object is read back and compared with
// what was written (the SHA-256 of its bytes and its number of lines, against the rows counted in the database), and
// only then are those rows deleted, with the role of the worker (`platform_app` cannot delete from audit_logs).
// Nothing is deleted early (only whole months older than the window), nothing is patched, and nothing is deleted
// whose copy was not verified. A month is one object: if a run finds it already there (the delete did not finish)
// the rows that are left go in the next part, never over the first. A month is exported by one run at a time: the
// run takes the advisory lock of the month (of a transaction, so it is let go when the connection closes, if the
// process dies, and it works behind PgBouncer) and a run that does not get it leaves the month to the one that has
// it, so that it never deletes an object the other one wrote or verified. The rows deleted are the ones that were
// written to the object, read back from it, and not every row the month holds at that moment.
@Injectable()
export class AuditColdExporter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(AuditColdExporter.name)
  }

  // `before`: the entries older than this instant may leave the database (the caller says now minus the hot window)
  async run(before: Date, now: Date = new Date()): Promise<AuditColdExportReport> {
    // The window is held here, where the delete is, and not only by the scheduler that queues the job: a job that
    // names a later instant (a hand-added or retried one) is held to the end of the hot window
    const hotEnd = new Date(now.getTime() - AuditColdExport.HOT_DAYS * DAY_MS)
    const limit = before.getTime() > hotEnd.getTime() ? hotEnd : before
    // A month leaves only once all of it is older than `limit`: its end is at or before the start of the month `limit` is in
    const bound = startOfUtcMonth(limit)
    const report: AuditColdExportReport = { months: [], more: false, busy: null }
    for (let done = 0; done < AuditColdExport.MAX_MONTHS_PER_RUN; done += 1) {
      const oldest = await this.prisma.client.auditLog.findFirst({
        where: { timestamp: { lt: bound } },
        orderBy: { timestamp: 'asc' },
        select: { timestamp: true }
      })
      if (oldest === null) return report
      const start = startOfUtcMonth(oldest.timestamp)
      const exported = await this.withMonthLock(start, () =>
        this.exportMonth(start, startOfNextUtcMonth(start))
      )
      if (exported === null) {
        // Another run has this month and is the one to finish it: asking for the oldest again would find it again
        report.busy = { year: start.getUTCFullYear(), month: start.getUTCMonth() + 1 }
        report.more = true
        this.logger.info(report.busy, 'a month of the audit log is held by another export run')
        return report
      }
      report.months.push(exported)
    }
    report.more =
      (await this.prisma.client.auditLog.findFirst({
        where: { timestamp: { lt: bound } },
        select: { id: true }
      })) !== null
    return report
  }

  // Runs `fn` while holding the lock of the month, or answers null at once when another run holds it. The lock lives
  // as long as the transaction that took it, which does nothing else: the export reads and writes on its own connections
  private async withMonthLock<T>(start: Date, fn: () => Promise<T>): Promise<T | null> {
    const key = auditColdExportLockKey(start.getUTCFullYear(), start.getUTCMonth() + 1)
    return this.prisma.transaction(
      async tx => {
        const rows = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS locked`
        if (rows[0]?.locked !== true) return null
        return fn()
      },
      { maxWait: AuditColdExport.LOCK_MAX_WAIT_MS, timeout: AuditColdExport.LOCK_TIMEOUT_MS }
    )
  }

  private async exportMonth(start: Date, end: Date) {
    const year = start.getUTCFullYear()
    const month = start.getUTCMonth() + 1
    const where = { timestamp: { gte: start, lt: end } }
    const expected = await this.prisma.client.auditLog.count({ where })
    const key = await this.freeKey(year, month)

    const gzip = createGzip()
    const written = createHash('sha256')
    // The hash of the bytes that go up is taken on their way, by the stream the upload reads
    const tee = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        written.update(chunk)
        done(null, chunk)
      }
    })
    // An error of the stream reaches the loop through its drain wait or its next write: this listener is only so that
    // one that comes while the loop is reading rows is not an uncaught exception
    gzip.on('error', () => undefined)
    gzip.pipe(tee)
    // The upload reads the stream while the rows are written into it, so a month never sits in memory
    const upload = this.storage.putStream(key, tee, AuditColdExport.CONTENT_TYPE)
    // An upload that fails stops reading the stream: the loop that writes into it would wait for a drain that never
    // comes. Destroying the stream with the error makes that wait (and the next write) fail into the catch below
    upload.catch((error: unknown) => {
      gzip.destroy(
        error instanceof Error ? error : new Error('the upload of the cold export failed')
      )
    })
    let rows = 0
    try {
      let cursor: { timestamp: Date; id: string } | undefined
      for (;;) {
        const batch = await this.prisma.client.auditLog.findMany({
          where:
            cursor === undefined
              ? where
              : {
                  ...where,
                  OR: [
                    { timestamp: { gt: cursor.timestamp } },
                    { timestamp: cursor.timestamp, id: { gt: cursor.id } }
                  ]
                },
          orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
          take: AuditColdExport.READ_BATCH
        })
        for (const entry of batch) {
          if (!gzip.write(`${JSON.stringify(entry)}\n`)) {
            await Promise.race([once(gzip, 'drain'), upload])
          }
        }
        rows += batch.length
        const last = batch.at(-1)
        if (last === undefined || batch.length < AuditColdExport.READ_BATCH) break
        cursor = { timestamp: last.timestamp, id: last.id }
      }
      gzip.end()
      await upload
    } catch (error) {
      gzip.destroy()
      tee.destroy()
      await upload.catch(() => undefined)
      // What was half written is not a copy: it goes, and the rows stay
      await this.storage.delete(key).catch(() => undefined)
      throw error
    }

    try {
      await this.verify(key, written.digest('hex'), rows, expected)
      // Rows that reached the month after the count (a late writer) are not in this copy and must not be deleted
      // with it: they wait for the next run, which writes them in the next part
      if ((await this.prisma.client.auditLog.count({ where })) !== rows) {
        throw new Error('the month changed while it was exported; nothing was deleted')
      }
    } catch (error) {
      // A copy that was not verified is not a copy: it goes, and the rows stay
      await this.storage.delete(key).catch(() => undefined)
      throw error
    }
    await this.deleteExportedRows(key)
    this.logger.info({ year, month, rows, key }, 'a month of the audit log went to cold storage')
    return { year, month, rows, key }
  }

  // The first part of the month that is not in the bucket yet
  private async freeKey(year: number, month: number): Promise<string> {
    for (let part = 1; ; part += 1) {
      const key = StorageKeys.auditArchive(year, month, part)
      if ((await this.storage.head(key)) === null) return key
    }
  }

  // The object read back is the one that was written: the same bytes, and as many lines as rows in the database
  private async verify(key: string, sha256: string, rows: number, expected: number): Promise<void> {
    if (rows !== expected) {
      throw new Error(`the cold export read ${rows} rows and the month holds ${expected}`)
    }
    const body = await this.storage.stream(key)
    if (body === null) throw new Error('the cold export is not in the bucket after the upload')
    const stored = createHash('sha256')
    let lines = 0
    // One pipeline: a failure of any stream (a corrupt gzip, a broken connection) destroys all of them
    await pipeline(
      body,
      new Transform({
        transform(chunk: Buffer, _encoding, done) {
          stored.update(chunk)
          done(null, chunk)
        }
      }),
      createGunzip(),
      new Writable({
        write(chunk: Buffer, _encoding, done) {
          for (const byte of chunk) if (byte === NEWLINE) lines += 1
          done()
        }
      })
    )
    if (stored.digest('hex') !== sha256 || lines !== rows) {
      throw new Error('the cold export in the bucket is not the one that was written')
    }
  }

  // Deletes the rows that are in the object, and only those: a row that reached the month after the export read it is
  // not in the object and stays for the next run. The ids are read back from the verified object, a batch at a time
  private async deleteExportedRows(key: string): Promise<void> {
    const body = await this.storage.stream(key)
    if (body === null) throw new Error('the cold export is not in the bucket to delete its rows')
    const gunzip = createGunzip()
    // A failure of the object stream reaches the loop through the gunzip stream, which pipe() does not do by itself
    body.on('error', (error: Error) => gunzip.destroy(error))
    const lines = createInterface({ input: body.pipe(gunzip), crlfDelay: Infinity })
    let ids: string[] = []
    for await (const line of lines) {
      const id = (JSON.parse(line) as { id: string }).id
      ids.push(id)
      if (ids.length >= AuditColdExport.DELETE_BATCH) {
        await this.deleteIds(ids)
        ids = []
      }
    }
    if (ids.length > 0) await this.deleteIds(ids)
  }

  private async deleteIds(ids: string[]): Promise<void> {
    await this.prisma.client.$executeRaw`DELETE FROM audit_logs WHERE id = ANY(${ids}::text[])`
  }
}
