import { InjectQueue } from '@nestjs/bullmq'
import { Inject, Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'
import type { Redis } from 'ioredis'
import { PinoLogger } from 'nestjs-pino'

import { errorName } from '@platform/channels/connections'
import { CacheKeys } from '@platform/core/cache'
import { PrismaService } from '@platform/core/database'
import { MediaStatus } from '@platform/core/domain'
import { JobNames, QueueNames, type ScanFileJob } from '@platform/core/queues'
import { REDIS_CLIENT } from '@platform/core/redis'
import {
  MediaObjectAreas,
  parseMediaObjectKey,
  STORES_ROOT,
  UploadLimits
} from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000

export interface CleanupReport {
  objectsDeleted: number
  scansRequeued: number
  rowsDropped: number
  infectedFilesDeleted: number
}

// Everything that a failure half way through leaves behind (TDD_07 §6). Each pass is safe to run
// twice, and none deletes anything that a row points to.
@Injectable()
export class OrphanMediaCleaner {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectQueue(QueueNames.HEAVY_PROCESSING) private readonly heavyQueue: Queue<ScanFileJob>,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(OrphanMediaCleaner.name)
  }

  // The passes are independent: one that fails does not keep the others from running, and is logged.
  // They sweep the whole bucket and table on purpose (no store is named): what they look at has no
  // owner any more, or is the platform's to keep.
  async run(now: Date = new Date()): Promise<CleanupReport> {
    const report: CleanupReport = {
      objectsDeleted: 0,
      scansRequeued: 0,
      rowsDropped: 0,
      infectedFilesDeleted: 0
    }
    report.objectsDeleted =
      (await this.pass('stray objects', () => this.deleteStrayObjects(now))) ?? 0
    report.infectedFilesDeleted =
      (await this.pass('infected files', () => this.deleteInfectedFiles())) ?? 0
    const stuck = await this.pass('stuck scans', () => this.settleStuckScans(now))
    report.scansRequeued = stuck?.requeued ?? 0
    report.rowsDropped = stuck?.dropped ?? 0
    return report
  }

  private async pass<T>(name: string, work: () => Promise<T>): Promise<T | null> {
    try {
      return await work()
    } catch (error) {
      this.logger.error(
        { pass: name, errorName: errorName(error) },
        'a pass of the media cleanup failed'
      )
      return null
    }
  }

  // Objects under uploads/ and messages/ older than the TTL that no row accounts for: a signed url that
  // was never confirmed, the staging copy a confirmation could not delete, a confirmation that died
  // between the copy and the row, the variants of a media that was dropped. A file in uploads/ is never
  // what a row points to; one in messages/ is kept while its media exists. Younger objects may belong
  // to a confirmation in flight, so they wait. The listing is resumed from where the last run stopped.
  private async deleteStrayObjects(now: Date): Promise<number> {
    const cutoff = now.getTime() - UploadLimits.UNCONFIRMED_UPLOAD_TTL_HOURS * HOUR_MS
    let deleted = 0
    let token = (await this.redis.get(CacheKeys.mediaCleanup.cursor())) ?? undefined
    for (let pages = 0; pages < UploadLimits.ORPHAN_LIST_PAGES_PER_RUN; pages++) {
      let page
      try {
        page = await this.storage.list(STORES_ROOT, token)
      } catch (error) {
        // A token the bucket refuses would fail every run: start over from the top next time
        await this.redis.del(CacheKeys.mediaCleanup.cursor())
        throw error
      }
      token = page.next
      const old = page.objects.flatMap(object => {
        const parsed = parseMediaObjectKey(object.key)
        return parsed !== null && object.lastModified.getTime() < cutoff
          ? [{ key: object.key, ...parsed }]
          : []
      })
      const messageIds = old
        .filter(object => object.area === MediaObjectAreas.MESSAGES)
        .map(object => object.mediaId)
      const known =
        messageIds.length === 0
          ? []
          : await this.prisma.client.media.findMany({
              where: { id: { in: messageIds } },
              select: { id: true }
            })
      const alive = new Set(known.map(row => row.id))
      for (const object of old) {
        if (object.area === MediaObjectAreas.MESSAGES && alive.has(object.mediaId)) continue
        try {
          await this.storage.delete(object.key)
          deleted += 1
        } catch (error) {
          // One object the bucket will not delete must not stop the rest, or the cursor
          this.logger.warn({ errorName: errorName(error) }, 'a stray object could not be deleted')
        }
      }
      // The progress is kept page by page: a failure later does not send the next run back to the top
      if (token === undefined) await this.redis.del(CacheKeys.mediaCleanup.cursor())
      else await this.redis.set(CacheKeys.mediaCleanup.cursor(), token)
      if (token === undefined || deleted >= UploadLimits.ORPHAN_CLEANUP_BATCH) break
    }
    return deleted
  }

  // The scan marks the row first and deletes the file second: a failure in between leaves the file of
  // an infected row. It is never served; here it goes.
  private async deleteInfectedFiles(): Promise<number> {
    // Only the verdicts of the last days: nothing marks a row as cleaned, and a failure of the delete
    // shows up within the retries of the scan, not weeks later
    const infected = await this.prisma.client.media.findMany({
      where: {
        status: MediaStatus.INFECTED,
        scannedAt: {
          gt: new Date(Date.now() - UploadLimits.INFECTED_CLEANUP_WINDOW_HOURS * HOUR_MS)
        }
      },
      select: { key: true },
      orderBy: { scannedAt: 'desc' },
      take: UploadLimits.ORPHAN_CLEANUP_BATCH
    })
    let deleted = 0
    for (const row of infected) {
      // One row the bucket answers badly for must not keep the others' files
      try {
        if ((await this.storage.head(row.key)) === null) continue
        await this.storage.delete(row.key)
        deleted += 1
      } catch (error) {
        this.logger.warn(
          { errorName: errorName(error) },
          'the file of an infected row was not deleted'
        )
      }
    }
    return deleted
  }

  // A row still pending long after it was made lost its scan job (Redis was down, the job expired):
  // queue it again under the same id. If the file is not there, no scan can ever finish: the row goes
  // once it is past the TTL (before that a confirmation may be mid-way).
  private async settleStuckScans(now: Date): Promise<{ requeued: number; dropped: number }> {
    const stuck = await this.prisma.client.media.findMany({
      where: {
        status: MediaStatus.PENDING,
        createdAt: { lt: new Date(now.getTime() - UploadLimits.STUCK_SCAN_MINUTES * MINUTE_MS) }
      },
      select: { id: true, key: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: UploadLimits.ORPHAN_CLEANUP_BATCH
    })
    const dropBefore = now.getTime() - UploadLimits.UNCONFIRMED_UPLOAD_TTL_HOURS * HOUR_MS
    let requeued = 0
    let dropped = 0
    for (const row of stuck) {
      // One row the bucket or the queue answers badly for must not keep the others from being settled
      try {
        if ((await this.storage.head(row.key)) !== null) {
          const existing = await this.heavyQueue.getJob(`${JobNames.SCAN_FILE}-${row.id}`)
          if (existing !== undefined) {
            // Waiting, delayed or running: it is on its way, and adding the same id would do nothing
            if (!(await existing.isCompleted()) && !(await existing.isFailed())) continue
            // A finished job keeps its id and would swallow a new one: it is removed first
            await existing.remove()
          }
          await this.heavyQueue.add(
            JobNames.SCAN_FILE,
            { mediaId: row.id },
            { jobId: `${JobNames.SCAN_FILE}-${row.id}` }
          )
          requeued += 1
        } else if (row.createdAt.getTime() < dropBefore) {
          await this.prisma.client.media.deleteMany({
            where: { id: row.id, status: MediaStatus.PENDING }
          })
          dropped += 1
        }
      } catch (error) {
        this.logger.warn({ errorName: errorName(error) }, 'a stuck scan could not be settled')
      }
    }
    if (requeued + dropped > 0) {
      this.logger.warn({ requeued, dropped }, 'media with a lost scan was settled')
    }
    return { requeued, dropped }
  }
}
