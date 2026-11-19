import { InjectQueue } from '@nestjs/bullmq'
import { Inject, Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'
import type { Redis } from 'ioredis'
import { PinoLogger } from 'nestjs-pino'

import { errorName } from '@platform/channels/connections'
import { CacheKeys } from '@platform/core/cache'
import { PrismaService, assertSeesEveryRow } from '@platform/core/database'
import { MediaStatus } from '@platform/core/domain'
import { JobNames, QueueNames, type ScanFileJob } from '@platform/core/queues'
import { REDIS_CLIENT } from '@platform/core/redis'
import {
  EvidenceMediaPurposes,
  MediaObjectAreas,
  MediaPurpose,
  objectKeysOf,
  parseAvatarKey,
  parseAvatarUploadKey,
  parseMediaObjectKey,
  STORES_ROOT,
  UploadLimits,
  USERS_ROOT
} from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MEDIA_ID = UUID

// What a scoped run may touch (`runScoped`), for a spec that shares the database and the bucket with other
// suites. The schedule calls `run`, which sweeps all of both. No route, job or payload can carry a scope. Rows
// and objects are limited by the same stores and users: the media of a store, the avatars of a user (an object
// by the prefix of each of them), and an empty list limits to nothing, never to everything.
export interface CleanupScope {
  storeIds: readonly string[]
  userIds: readonly string[]
}

export interface CleanupReport {
  objectsDeleted: number
  scansRequeued: number
  rowsDropped: number
  infectedFilesDeleted: number
  unsentFilesDropped: number
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
    return this.sweepAll(now, undefined)
  }

  // The same passes, limited to the stores and users named: for a spec that shares the database and the bucket
  // with others. A separate method and a required argument, so that forgetting the scope is a compile error
  // and never a sweep of everything. Rows are limited by store (and by the avatars of the users); objects by
  // the prefix of each store and user. A scoped run does not use the cursors of the schedule, so it lists each
  // prefix from the top and counts its batch per prefix: that is for the few objects of a spec.
  async runScoped(scope: CleanupScope, now: Date = new Date()): Promise<CleanupReport> {
    checkScope(scope)
    return this.sweepAll(now, scope)
  }

  private async sweepAll(now: Date, scope: CleanupScope | undefined): Promise<CleanupReport> {
    // A file is orphan when no row names it: a row that row security hides would make every file of the bucket an orphan
    await assertSeesEveryRow(this.prisma, ['media', 'users'])
    const report: CleanupReport = {
      objectsDeleted: 0,
      scansRequeued: 0,
      rowsDropped: 0,
      infectedFilesDeleted: 0,
      unsentFilesDropped: 0
    }
    report.objectsDeleted =
      (await this.pass('stray objects', () => this.deleteStrayObjects(now, scope))) ?? 0
    report.objectsDeleted +=
      (await this.pass('stray avatar uploads', () => this.deleteStrayAvatarUploads(now, scope))) ??
      0
    report.rowsDropped +=
      (await this.pass('unattached avatars', () => this.dropUnattachedAvatars(now, scope))) ?? 0
    report.infectedFilesDeleted =
      (await this.pass('infected files', () => this.deleteInfectedFiles(scope))) ?? 0
    report.unsentFilesDropped =
      (await this.pass('unsent message files', () => this.dropUnsentMessageFiles(now, scope))) ?? 0
    const stuck = await this.pass('stuck scans', () => this.settleStuckScans(now, scope))
    report.scansRequeued = stuck?.requeued ?? 0
    report.rowsDropped += stuck?.dropped ?? 0
    return report
  }

  // Where a listing of the schedule resumes. A run limited to some prefixes has no cursor: it reads nothing,
  // and writes and clears nothing, so it cannot move the schedule's.
  private cursorOf(
    key: string,
    resumable: boolean
  ): {
    read: () => Promise<string | undefined>
    save: (token: string | undefined) => Promise<void>
    clear: () => Promise<void>
  } {
    return {
      read: async () => (resumable ? ((await this.redis.get(key)) ?? undefined) : undefined),
      save: async token => {
        if (!resumable) return
        if (token === undefined) await this.redis.del(key)
        else await this.redis.set(key, token)
      },
      clear: async () => {
        if (resumable) await this.redis.del(key)
      }
    }
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
  private async deleteStrayObjects(now: Date, scope?: CleanupScope): Promise<number> {
    const roots =
      scope === undefined ? [STORES_ROOT] : scope.storeIds.map(id => `${STORES_ROOT}${id}/`)
    let deleted = 0
    for (const root of roots) {
      deleted += await this.sweepStoreRoot(root, now, scope === undefined)
      if (deleted >= UploadLimits.ORPHAN_CLEANUP_BATCH) break
    }
    return deleted
  }

  // One listing of the stores' root, or of the root of one store. Only the whole root is resumed from where
  // the last run stopped: the cursor is the schedule's, and a run limited to some stores has its own start.
  private async sweepStoreRoot(root: string, now: Date, resumable: boolean): Promise<number> {
    const cutoff = now.getTime() - UploadLimits.UNCONFIRMED_UPLOAD_TTL_HOURS * HOUR_MS
    const cursor = this.cursorOf(CacheKeys.mediaCleanup.cursor(), resumable)
    let deleted = 0
    let token = await cursor.read()
    for (let pages = 0; pages < UploadLimits.ORPHAN_LIST_PAGES_PER_RUN; pages++) {
      let page
      try {
        page = await this.storage.list(root, token)
      } catch (error) {
        // A token the bucket refuses would fail every run: start over from the top next time
        await cursor.clear()
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
      await cursor.save(token)
      if (token === undefined || deleted >= UploadLimits.ORPHAN_CLEANUP_BATCH) break
    }
    return deleted
  }

  // The staging objects of avatars (users/<id>/avatar-uploads/...) older than the TTL. A row never
  // points to one: confirming copies the file to its final key and deletes this one, so any that is
  // left is a signed url that was never confirmed or a delete that failed. The final files
  // (users/<id>/avatar/...) are not matched and stay. Resumed from its own cursor, apart from the stores'.
  private async deleteStrayAvatarUploads(now: Date, scope?: CleanupScope): Promise<number> {
    const roots =
      scope === undefined ? [USERS_ROOT] : scope.userIds.map(id => `${USERS_ROOT}${id}/`)
    let deleted = 0
    for (const root of roots) {
      deleted += await this.sweepUsersRoot(root, now, scope === undefined)
      if (deleted >= UploadLimits.ORPHAN_CLEANUP_BATCH) break
    }
    return deleted
  }

  private async sweepUsersRoot(root: string, now: Date, resumable: boolean): Promise<number> {
    const cutoff = now.getTime() - UploadLimits.UNCONFIRMED_UPLOAD_TTL_HOURS * HOUR_MS
    const cursor = this.cursorOf(CacheKeys.mediaCleanup.avatarCursor(), resumable)
    let deleted = 0
    let token = await cursor.read()
    for (let pages = 0; pages < UploadLimits.ORPHAN_LIST_PAGES_PER_RUN; pages++) {
      let page
      try {
        page = await this.storage.list(root, token)
      } catch (error) {
        await cursor.clear()
        throw error
      }
      token = page.next
      // A final avatar file (users/<id>/avatar/<media>/...) is stray when the row of its media id does not
      // point at it: there is no row (the row of a replaced picture goes first and its file second, and a
      // failure in between leaves it), or the worker re-encoded the picture and the file it was made from
      // was not deleted
      const finals = page.objects.flatMap(object => {
        const parsed = parseAvatarKey(object.key)
        return parsed !== null && object.lastModified.getTime() < cutoff
          ? [{ key: object.key, mediaId: parsed.mediaId }]
          : []
      })
      // Only a key whose media id is a real id is looked up; one that is not has no row by definition
      const lookable = finals.filter(object => MEDIA_ID.test(object.mediaId))
      const known =
        lookable.length === 0
          ? []
          : await this.prisma.client.media.findMany({
              where: { id: { in: lookable.map(object => object.mediaId) } },
              select: { id: true, key: true }
            })
      const alive = new Set(known.map(row => row.key))
      const strayFinals = new Set(
        finals.filter(object => !alive.has(object.key)).map(object => object.key)
      )
      for (const object of page.objects) {
        const stagingStray =
          parseAvatarUploadKey(object.key) !== null && object.lastModified.getTime() < cutoff
        if (!stagingStray && !strayFinals.has(object.key)) continue
        try {
          await this.storage.delete(object.key)
          deleted += 1
        } catch (error) {
          this.logger.warn({ errorName: errorName(error) }, 'a stray avatar upload was not deleted')
        }
      }
      await cursor.save(token)
      if (token === undefined || deleted >= UploadLimits.ORPHAN_CLEANUP_BATCH) break
    }
    return deleted
  }

  // An avatar that was uploaded and confirmed but never became anyone's picture, or that the scan
  // refused: the row of a user's picture is the one `users.avatar_media_id` names. Older than the TTL,
  // so a confirmation about to be attached is left alone. The file goes first and the row second, so a
  // failure leaves a row the next run finds again and not a file nobody can name.
  private async dropUnattachedAvatars(now: Date, scope?: CleanupScope): Promise<number> {
    const cutoff = new Date(now.getTime() - UploadLimits.UNCONFIRMED_UPLOAD_TTL_HOURS * HOUR_MS)
    // `all` is a run of the schedule; a scoped run reaches the avatars of its users alone
    const all = scope === undefined
    const userIds = [...(scope?.userIds ?? [])]
    // One statement decides and deletes: a user who attaches the picture at this moment either commits
    // first (the row is kept) or finds no row to attach, never a row that this run removes under it.
    // Two runs at once take different rows (SKIP LOCKED). The file goes second: a failure leaves a file
    // with no row, which the sweep of stray avatar files finds by its media id.
    // A picture the scan or the re-encode refused is no picture: the pointer of the person who attached it
    // while it was pending is cleared, so the row is no longer held and goes below
    await this.prisma.client.$executeRaw`
      UPDATE users SET avatar_media_id = NULL WHERE avatar_media_id IN (
        SELECT id FROM media
        WHERE purpose = ${MediaPurpose.AVATAR} AND store_id IS NULL AND created_at < ${cutoff}
          AND (${all}::boolean OR uploaded_by = ANY(${userIds}::text[]))
          AND status IN (${MediaStatus.INFECTED}, ${MediaStatus.UNSCANNABLE}))`
    const rows = await this.prisma.client.$queryRaw<{ key: string }[]>`
      DELETE FROM media WHERE id IN (
        SELECT m.id FROM media m
        WHERE m.purpose = ${MediaPurpose.AVATAR} AND m.store_id IS NULL AND m.created_at < ${cutoff}
          AND (${all}::boolean OR m.uploaded_by = ANY(${userIds}::text[]))
          AND NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar_media_id = m.id)
        ORDER BY m.created_at LIMIT ${UploadLimits.ORPHAN_CLEANUP_BATCH}
        FOR UPDATE OF m SKIP LOCKED)
      RETURNING key`
    for (const row of rows) {
      try {
        await this.storage.delete(row.key)
      } catch (error) {
        this.logger.warn({ errorName: errorName(error) }, 'an unattached avatar was not deleted')
      }
    }
    return rows.length
  }

  // A file an agent uploaded and confirmed for a message and never sent: its row has no message, no
  // customer and no delivery state (sending a message sets all three in the same transaction, so a file that
  // was sent and lost its message or customer afterwards still has its delivery state and is never taken), so nothing shows it and it would sit
  // there until the retention of the store. It goes once it is older than the TTL of an unsent file, longer
  // than the one of an unconfirmed upload because an agent may leave a draft for a day or two. Files of
  // customers never match (their row is made with its message), nor does a file of another purpose.
  // One statement decides and deletes: an agent who sends the file at this moment either links it first
  // (the row is kept), or its link fails with the conflict of a file already attached when this run removed
  // the row between the check and the link (a file over two days old; the message is not sent either way). Two runs
  // at once take different rows (SKIP LOCKED). The objects go second: a failure leaves objects with no row,
  // which the sweep of stray objects finds.
  private async dropUnsentMessageFiles(now: Date, scope?: CleanupScope): Promise<number> {
    const cutoff = new Date(now.getTime() - UploadLimits.UNSENT_MESSAGE_FILE_TTL_HOURS * HOUR_MS)
    const all = scope === undefined
    const storeIds = [...(scope?.storeIds ?? [])]
    const rows = await this.prisma.client.$queryRaw<
      { store_id: string; key: string; variants: unknown }[]
    >`
      DELETE FROM media WHERE id IN (
        SELECT m.id FROM media m
        WHERE m.purpose = ${MediaPurpose.MESSAGE} AND m.store_id IS NOT NULL
          AND m.message_id IS NULL AND m.customer_id IS NULL AND m.delivery_status IS NULL
          AND m.uploaded_by IS NOT NULL
          AND m.created_at < ${cutoff}
          AND (${all}::boolean OR m.store_id = ANY(${storeIds}::text[]))
        ORDER BY m.created_at LIMIT ${UploadLimits.ORPHAN_CLEANUP_BATCH}
        FOR UPDATE OF m SKIP LOCKED)
      RETURNING store_id, key, variants`
    for (const row of rows) {
      const { keys, foreign } = objectKeysOf(row.store_id, row)
      if (foreign.length > 0) {
        this.logger.warn({ count: foreign.length }, 'an unsent file had a key outside its store')
      }
      for (const key of keys) {
        try {
          await this.storage.delete(key)
        } catch (error) {
          this.logger.warn({ errorName: errorName(error) }, 'an unsent file was not deleted')
        }
      }
    }
    if (rows.length > 0) {
      this.logger.warn({ dropped: rows.length }, 'message files that were never sent were dropped')
    }
    return rows.length
  }

  // The scan marks the row first and deletes the file second: a failure in between leaves the file of
  // an infected or unscannable row. It is never served; here it goes.
  private async deleteInfectedFiles(scope?: CleanupScope): Promise<number> {
    // Only the verdicts of the last days: nothing marks a row as cleaned, and a failure of the delete
    // shows up within the retries of the scan, not weeks later
    const infected = await this.prisma.client.media.findMany({
      where: {
        status: { in: [MediaStatus.INFECTED, MediaStatus.UNSCANNABLE] },
        // Financial evidence stays in the bucket, unserved (HC-122)
        purpose: { notIn: [...EvidenceMediaPurposes] },
        scannedAt: {
          gt: new Date(Date.now() - UploadLimits.INFECTED_CLEANUP_WINDOW_HOURS * HOUR_MS)
        },
        ...ownedBy(scope)
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
          'the file of an infected or unscannable row was not deleted'
        )
      }
    }
    return deleted
  }

  // A row whose scan gave up for good is `unscannable`, not `pending`, so it is not queued again here.
  // A row still pending long after it was made lost its scan job (Redis was down, the job expired):
  // queue it again under the same id. If the file is not there, no scan can ever finish: the row goes
  // once it is past the TTL (before that a confirmation may be mid-way).
  private async settleStuckScans(
    now: Date,
    scope?: CleanupScope
  ): Promise<{ requeued: number; dropped: number }> {
    // The evidence of a fiscal document is never dropped (the database says so) and is repaired and scanned again when it is asked for,
    // so it never fills the batch of this sweep. A finance document (a receipt, a statement) whose scan keeps failing stays pending and
    // is queued again here every pass (HC-122): it has a batch of its own, so a pile of them never starves the scans of other files
    const stuckWhere = (purpose: string | object) => ({
      status: MediaStatus.PENDING,
      purpose,
      createdAt: { lt: new Date(now.getTime() - UploadLimits.STUCK_SCAN_MINUTES * MINUTE_MS) },
      ...ownedBy(scope)
    })
    const pick = (purpose: string | object) =>
      this.prisma.client.media.findMany({
        where: stuckWhere(purpose),
        select: {
          id: true,
          key: true,
          createdAt: true,
          storeId: true,
          uploadedBy: true,
          purpose: true
        },
        orderBy: { createdAt: 'asc' },
        take: UploadLimits.ORPHAN_CLEANUP_BATCH
      })
    const stuck = [
      ...(await pick({ notIn: [MediaPurpose.FISCAL_EVIDENCE, MediaPurpose.FINANCE_DOCUMENT] })),
      ...(await pick(MediaPurpose.FINANCE_DOCUMENT))
    ]
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
          // The job names the context of its work: the store of the file, or the person of an avatar (a file with neither has no owner
          // that could read it, so there is nothing to scan for)
          const owner =
            row.storeId !== null
              ? { storeId: row.storeId }
              : row.uploadedBy !== null && row.purpose === String(MediaPurpose.AVATAR)
                ? { userId: row.uploadedBy }
                : null
          if (owner === null) {
            this.logger.warn(
              { mediaId: row.id },
              'a pending file with no store and no avatar owner was not queued'
            )
            continue
          }
          await this.heavyQueue.add(
            JobNames.SCAN_FILE,
            { mediaId: row.id, ...owner },
            { jobId: `${JobNames.SCAN_FILE}-${row.id}` }
          )
          requeued += 1
        } else if (row.createdAt.getTime() < dropBefore) {
          const removed = await this.prisma.client.media.deleteMany({
            where: {
              id: row.id,
              status: MediaStatus.PENDING,
              purpose: { not: MediaPurpose.FISCAL_EVIDENCE }
            }
          })
          dropped += removed.count
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

// The rows of a run limited to some stores and users: a media of a store, or the avatar of a user
export function ownedBy(scope: CleanupScope | undefined): {
  OR?: (
    { storeId: { in: string[] } } | { storeId: null; purpose: string; uploadedBy: { in: string[] } }
  )[]
} {
  return scope === undefined
    ? {}
    : {
        OR: [
          { storeId: { in: [...scope.storeIds] } },
          // A user's own files are their avatar, the only media with no store
          { storeId: null, purpose: MediaPurpose.AVATAR, uploadedBy: { in: [...scope.userIds] } }
        ]
      }
}

// An id that is not an id would make a prefix (an empty one, `..`) that reaches more than its owner
function checkScope(scope: CleanupScope): void {
  for (const [kind, ids] of [
    ['store', scope.storeIds],
    ['user', scope.userIds]
  ] as const) {
    for (const id of ids) {
      // Stores and users have uuids, as media do
      if (!UUID.test(id))
        throw new Error(`the scope of a cleanup holds a ${kind} id that is not a uuid`)
    }
  }
}
