import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'

import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { AuditColdExport } from '@platform/core/compliance'
import { PrismaService } from '@platform/core/database'
import { DAY_MS } from '@platform/core/domain'
import { StorageKeys } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { startOfNextUtcMonth, startOfUtcMonth } from './retention-clock'

export interface AuditColdExportReport {
  months: { year: number; month: number; rows: number; key: string }[]
  // True when months past the window are left for the next run
  more: boolean
}

const NEWLINE = 0x0a

// The cold export of the audit log (TDD_05 §9.3, monthly): every entry of a calendar month that is entirely past the
// hot window (two years) goes to the bucket as a gzipped JSON lines file, the object is read back and compared with
// what was written (the SHA-256 of its bytes and its number of lines, against the rows counted in the database), and
// only then are those rows deleted, with the role of the worker (`platform_app` cannot delete from audit_logs).
// Nothing is deleted early (only whole months older than the window), nothing is patched, and nothing is deleted
// whose copy was not verified. A month is one object: if a run finds it already there (the delete did not finish)
// the rows that are left go in the next part, never over the first.
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
    const report: AuditColdExportReport = { months: [], more: false }
    for (let done = 0; done < AuditColdExport.MAX_MONTHS_PER_RUN; done += 1) {
      const oldest = await this.prisma.client.auditLog.findFirst({
        where: { timestamp: { lt: bound } },
        orderBy: { timestamp: 'asc' },
        select: { timestamp: true }
      })
      if (oldest === null) return report
      const start = startOfUtcMonth(oldest.timestamp)
      report.months.push(await this.exportMonth(start, startOfNextUtcMonth(start)))
    }
    report.more =
      (await this.prisma.client.auditLog.findFirst({
        where: { timestamp: { lt: bound } },
        select: { id: true }
      })) !== null
    return report
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
    await this.deleteRows(start, end)
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

  private async deleteRows(start: Date, end: Date): Promise<void> {
    for (;;) {
      const deleted = await this.prisma.client.$executeRaw`
        DELETE FROM audit_logs WHERE id IN (
          SELECT id FROM audit_logs
          WHERE timestamp >= (${start.toISOString()}::timestamptz AT TIME ZONE 'UTC')
            AND timestamp < (${end.toISOString()}::timestamptz AT TIME ZONE 'UTC')
          LIMIT ${AuditColdExport.DELETE_BATCH})`
      if (deleted < AuditColdExport.DELETE_BATCH) return
    }
  }
}
