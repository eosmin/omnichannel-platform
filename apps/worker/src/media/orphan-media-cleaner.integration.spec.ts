import { randomUUID } from 'node:crypto'

import { getQueueToken } from '@nestjs/bullmq'
import { Test, type TestingModule } from '@nestjs/testing'
import type { Queue } from 'bullmq'
import type { Redis } from 'ioredis'
import pg from 'pg'

import { CacheKeys } from '@platform/core/cache'
import { JobContext, JobContextError, PrismaService } from '@platform/core/database'
import { connectionUrls } from '@platform/core/database-testing'
import { JobNames, QueueNames, ScanFileRetry } from '@platform/core/queues'
import { REDIS_CLIENT } from '@platform/core/redis'
import { STORES_ROOT, StorageKeys, UploadLimits, USERS_ROOT } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { dropJob } from '../testing/drop-job'
import { WorkerModule } from '../worker.module'

import {
  type CleanupScope,
  OrphanMediaCleaner,
  SweepAbortError
} from './orphan-media-cleaner.service'

const HOUR_MS = 3_600_000

// What a failure half way through leaves behind, against the real bucket, database and queue. The
// cleaner is run "in the future" instead of waiting a day: objects cannot be given an old date. That clock
// makes every unattached avatar and every stray object of the last hour look a day old, and the database
// and the bucket are shared with the suites that run beside this one (in CI, the api's), so a run here
// reaches only the stores and the users of its own case (`CleanupScope`); the cases that check the sweep
// of everything say so.
describe('OrphanMediaCleaner', () => {
  let moduleRef: TestingModule
  let cleaner: OrphanMediaCleaner
  let storage: StorageService
  let heavy: Queue
  let owner: pg.Client
  let redis: Redis
  const organizationId = randomUUID()
  const storeId = randomUUID()
  const keys: string[] = []

  // How many rows the media table holds for the id, seen as the owner of the database and not through the connection of the worker:
  // with the policies enforced that one sees a row only inside the context of its store, and what is checked here is the row
  async function mediaRowCount(id: string): Promise<number> {
    const { rowCount } = await owner.query('SELECT 1 FROM media WHERE id = $1', [id])
    return rowCount ?? 0
  }
  const later = () =>
    new Date(Date.now() + (UploadLimits.UNCONFIRMED_UPLOAD_TTL_HOURS + 1) * HOUR_MS)
  // The users a case makes files or rows for: its scope, with the store of the suite
  const touchedUsers = new Set<string>()
  const mine = (): CleanupScope => ({ storeIds: [storeId], userIds: [...touchedUsers] })
  const sweep = (now?: Date) => cleaner.runScoped(mine(), now)
  // The passes a case does not test, replaced by nothing: a run without a scope looks at the whole shared
  // database and bucket, and a case that checks one pass has no business reaching the others of the suites
  // beside it
  type Pass =
    | 'deleteStrayObjects'
    | 'deleteStrayAvatarUploads'
    | 'dropUnattachedAvatars'
    | 'deleteRefusedFiles'
    | 'settleStuckScans'
    | 'dropUnsentMessageFiles'
  const quiet = (...passes: Pass[]) =>
    passes.map(pass =>
      jest
        .spyOn(cleaner as never, pass as never)
        .mockResolvedValue((pass === 'settleStuckScans' ? { requeued: 0, dropped: 0 } : 0) as never)
    )

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(PrismaService)
      .useValue(new PrismaService({ databaseUrl: connectionUrls().worker }))
      .compile()
    cleaner = moduleRef.get(OrphanMediaCleaner, { strict: false })
    storage = moduleRef.get(StorageService, { strict: false })
    heavy = moduleRef.get(getQueueToken(QueueNames.HEAVY_PROCESSING), { strict: false })
    redis = moduleRef.get<Redis>(REDIS_CLIENT, { strict: false })
    owner = new pg.Client({ connectionString: connectionUrls().owner })
    await owner.connect()
    const slug = `it-orphan-${storeId.slice(0, 8)}`
    await owner.query(
      `INSERT INTO organizations (id, name, slug, updated_at) VALUES ($1, $2, $2, now())`,
      [organizationId, slug]
    )
    await owner.query(
      `INSERT INTO stores (id, organization_id, name, slug, updated_at) VALUES ($1, $2, $3, $3, now())`,
      [storeId, organizationId, slug]
    )
  })

  afterAll(async () => {
    // Nothing of the schedule's progress outlives the suite
    await redis.del(CacheKeys.mediaCleanup.cursor())
    await redis.del(CacheKeys.mediaCleanup.avatarCursor())
    for (const key of keys) await storage.delete(key)
    await owner.query(`DELETE FROM organizations WHERE id = $1`, [organizationId])
    await owner.end()
    await moduleRef.close()
  })

  // A run that did not reach the end of a shared bucket leaves a cursor: every case starts from the top
  beforeEach(async () => {
    await redis.del(CacheKeys.mediaCleanup.cursor())
    await redis.del(CacheKeys.mediaCleanup.avatarCursor())
  })

  async function object(key: string): Promise<string> {
    await storage.put(key, Buffer.from('x'), 'text/plain')
    keys.push(key)
    const owner = /^users\/([^/]+)\//.exec(key)?.[1]
    if (owner !== undefined) touchedUsers.add(owner)
    return key
  }

  async function row(status: string, key: string, id: string = randomUUID()): Promise<string> {
    await owner.query(
      `INSERT INTO media (id, store_id, purpose, key, filename, content_type, file_size, status, created_at)
       VALUES ($1, $2, 'message', $3, 'f.txt', 'text/plain', 1, $4, now() - interval '2 hours')`,
      [id, storeId, key, status]
    )
    return id
  }

  it('deletes an upload nobody confirmed and keeps the file of a media row', async () => {
    const stray = await object(StorageKeys.messageUpload(storeId, randomUUID(), 'a.txt'))
    const strayFinal = await object(StorageKeys.message(storeId, randomUUID(), 'b.txt'))
    const keptId = randomUUID()
    const keptKey = await object(StorageKeys.message(storeId, keptId, 'c.txt'))
    await row('clean', keptKey, keptId)

    await sweep(later())

    expect(await storage.head(stray)).toBeNull()
    expect(await storage.head(strayFinal)).toBeNull()
    expect(await storage.head(keptKey)).not.toBeNull()
  })

  it('aborts the whole sweep, deleting nothing, when the rows of a store cannot be read', async () => {
    const stray = await object(StorageKeys.message(storeId, randomUUID(), 'abort.txt'))
    const strayUpload = await object(StorageKeys.messageUpload(storeId, randomUUID(), 'abort.txt'))
    const jobContext = moduleRef.get(JobContext, { strict: false })
    const failing = jest
      .spyOn(jobContext, 'forStore')
      .mockRejectedValue(new JobContextError('the context of the store could not be opened'))
    try {
      await expect(sweep(later())).rejects.toBeInstanceOf(SweepAbortError)
    } finally {
      failing.mockRestore()
    }
    // A file with no row is deleted only when its store was read: this one was not, so nothing of the page went
    expect(await storage.head(stray)).not.toBeNull()
    expect(await storage.head(strayUpload)).not.toBeNull()
  })

  it('aborts at the store that cannot be read and deletes nothing of it', async () => {
    const otherStoreId = randomUUID()
    const slug = `it-orphan-${otherStoreId.slice(0, 8)}`
    await owner.query(
      `INSERT INTO stores (id, organization_id, name, slug, updated_at) VALUES ($1, $2, $3, $3, now())`,
      [otherStoreId, organizationId, slug]
    )
    await object(StorageKeys.message(storeId, randomUUID(), 'both-a.txt'))
    const unreadable = await object(StorageKeys.message(otherStoreId, randomUUID(), 'both-b.txt'))
    const jobContext = moduleRef.get(JobContext, { strict: false })
    const real = jobContext.forStore.bind(jobContext)
    const failing = jest
      .spyOn(jobContext, 'forStore')
      .mockImplementation((id, work, options) =>
        id === otherStoreId
          ? Promise.reject(new JobContextError('the context of the store could not be opened'))
          : real(id, work, options)
      )
    try {
      await expect(
        cleaner.runScoped({ storeIds: [storeId, otherStoreId], userIds: [] }, later())
      ).rejects.toBeInstanceOf(SweepAbortError)
    } finally {
      failing.mockRestore()
    }
    // The roots are swept in order: the store that could be read was judged whole, the one that could not has nothing deleted
    expect(await storage.head(unreadable)).not.toBeNull()
  })

  it('deletes the variants of a media that no longer exists, and keeps those of one that does', async () => {
    const goneId = randomUUID()
    const goneVariant = await object(StorageKeys.messageVariant(storeId, goneId, 'thumb'))
    const aliveKey = await object(StorageKeys.message(storeId, randomUUID(), 'd.png'))
    const aliveId = aliveKey.split('/')[3] ?? ''
    await row('clean', aliveKey, aliveId)
    const aliveVariant = await object(StorageKeys.messageVariant(storeId, aliveId, 'thumb'))

    await sweep(later())

    expect(await storage.head(goneVariant)).toBeNull()
    expect(await storage.head(aliveVariant)).not.toBeNull()
  })

  it('deletes the staging copy of a media that was confirmed', async () => {
    const id = randomUUID()
    const staging = await object(StorageKeys.messageUpload(storeId, id, 'e.txt'))
    await row('clean', StorageKeys.message(storeId, id, 'e.txt'), id)

    await sweep(later())

    expect(await storage.head(staging)).toBeNull()
  })

  it('deletes the staging file of an avatar nobody confirmed', async () => {
    const staging = await object(StorageKeys.avatarUpload(randomUUID(), randomUUID(), 'me.png'))

    await sweep(later())

    expect(await storage.head(staging)).toBeNull()
  })

  // The users these cases make go with their rows, whether the case passed or not
  const avatarUsers: string[] = []
  afterEach(async () => {
    const ids = avatarUsers.splice(0)
    touchedUsers.clear()
    await owner.query(`DELETE FROM media WHERE uploaded_by = ANY($1)`, [ids])
    await owner.query(`DELETE FROM users WHERE id = ANY($1)`, [ids])
  })

  async function avatarRow(
    userId: string,
    id: string,
    key: string,
    status = 'clean',
    age = '3 days'
  ) {
    touchedUsers.add(userId)
    await owner.query(
      `INSERT INTO media (id, store_id, purpose, uploaded_by, key, filename, content_type, file_size, status, created_at)
       VALUES ($1, NULL, 'avatar', $2, $3, 'me.png', 'image/png', 1, $4, now() - $5::interval)`,
      [id, userId, key, status, age]
    )
  }

  it('drops an avatar nobody attached, file and row, and keeps the one a user has', async () => {
    const userId = randomUUID()
    avatarUsers.push(userId)
    await owner.query(
      `INSERT INTO users (id, email, name, updated_at) VALUES ($1, $2, 'avatar owner', now())`,
      [userId, `it-avatar-${userId}@example.com`]
    )
    const heldId = randomUUID()
    const heldKey = await object(StorageKeys.avatar(userId, heldId, 'me.png'))
    await avatarRow(userId, heldId, heldKey)
    await owner.query(`UPDATE users SET avatar_media_id = $1 WHERE id = $2`, [heldId, userId])
    const looseId = randomUUID()
    const looseKey = await object(StorageKeys.avatar(userId, looseId, 'me.png'))
    await avatarRow(userId, looseId, looseKey)

    await sweep()

    expect(await storage.head(looseKey)).toBeNull()
    expect(await storage.head(heldKey)).not.toBeNull()
    const rows = await owner.query(`SELECT id FROM media WHERE id = ANY($1)`, [[heldId, looseId]])
    expect(rows.rows.map((row: { id: string }) => row.id)).toEqual([heldId])
  })

  it('spares an avatar confirmed a moment ago that nobody has attached yet: the attach may be in flight', async () => {
    const userId = randomUUID()
    avatarUsers.push(userId)
    await owner.query(
      `INSERT INTO users (id, email, name, updated_at) VALUES ($1, $2, 'avatar owner', now())`,
      [userId, `it-avatar-${userId}@example.com`]
    )
    const freshId = randomUUID()
    const freshKey = await object(StorageKeys.avatar(userId, freshId, 'me.png'))
    await avatarRow(userId, freshId, freshKey, 'clean', '1 hour')

    await sweep()

    expect(await storage.head(freshKey)).not.toBeNull()
    const rows = await owner.query(`SELECT id FROM media WHERE id = $1`, [freshId])
    expect(rows.rows).toHaveLength(1)
  })

  it('resumes the sweep of stray avatar uploads from where the last run stopped', async () => {
    // The bucket is shared with other suites, so the listing of the users root is replaced by one of
    // our own: a long run of empty pages, and the stray staging object on the page after the cap. The
    // object is given the oldest date there is, so this case needs no clock in the future and sweeps
    // nothing of the others; it is the one that runs without a scope, because the cursor is the schedule's.
    const stray = StorageKeys.avatarUpload(randomUUID(), randomUUID(), 'old.png')
    const lastPage = UploadLimits.ORPHAN_LIST_PAGES_PER_RUN
    // Only the sweep of the avatar uploads is under test, and it is the one that has a cursor
    const quieted = quiet(
      'deleteStrayObjects',
      'dropUnattachedAvatars',
      'deleteRefusedFiles',
      'dropUnsentMessageFiles',
      'settleStuckScans'
    )
    const real = storage.list.bind(storage)
    const asked: (string | undefined)[] = []
    const listing = jest.spyOn(storage, 'list').mockImplementation((prefix, token) => {
      if (prefix !== USERS_ROOT) return real(prefix, token)
      asked.push(token)
      const page = token === undefined ? 0 : Number(token.slice(1))
      return Promise.resolve(
        page < lastPage
          ? { objects: [], next: `P${page + 1}` }
          : { objects: [{ key: stray, lastModified: new Date(0) }], next: undefined }
      )
    })
    // Only the stray key is intercepted: everything else is deleted for real, as in the other cases
    const realDelete = storage.delete.bind(storage)
    const deleting = jest
      .spyOn(storage, 'delete')
      .mockImplementation(key => (key === stray ? Promise.resolve() : realDelete(key)))
    try {
      await cleaner.run()

      expect(asked).toHaveLength(lastPage)
      expect(deleting).not.toHaveBeenCalledWith(stray)
      expect(await redis.get(CacheKeys.mediaCleanup.avatarCursor())).toBe(`P${lastPage}`)

      asked.length = 0
      await cleaner.run()

      expect(asked[0]).toBe(`P${lastPage}`)
      expect(deleting).toHaveBeenCalledWith(stray)
      expect(await redis.get(CacheKeys.mediaCleanup.avatarCursor())).toBeNull()
    } finally {
      listing.mockRestore()
      deleting.mockRestore()
      for (const spy of quieted) spy.mockRestore()
    }
  })

  it('deletes the file of an avatar whose row is gone, and keeps the file of a row that is there', async () => {
    const userId = randomUUID()
    const goneKey = await object(StorageKeys.avatar(userId, randomUUID(), 'me.png'))
    const aliveId = randomUUID()
    const aliveKey = await object(StorageKeys.avatar(userId, aliveId, 'me.png'))
    avatarUsers.push(userId)
    await owner.query(
      `INSERT INTO users (id, email, name, updated_at) VALUES ($1, $2, 'avatar owner', now())`,
      [userId, `it-avatar-${userId}@example.com`]
    )
    await avatarRow(userId, aliveId, aliveKey)
    await owner.query(`UPDATE users SET avatar_media_id = $1 WHERE id = $2`, [aliveId, userId])

    await sweep(later())

    expect(await storage.head(goneKey)).toBeNull()
    expect(await storage.head(aliveKey)).not.toBeNull()
  })

  it('deletes the uploaded file of an avatar that was re-encoded, and keeps the one the row names', async () => {
    const userId = randomUUID()
    const id = randomUUID()
    avatarUsers.push(userId)
    await owner.query(
      `INSERT INTO users (id, email, name, updated_at) VALUES ($1, $2, 'avatar owner', now())`,
      [userId, `it-avatar-${userId}@example.com`]
    )
    const uploaded = await object(StorageKeys.avatar(userId, id, 'me.jpg'))
    const served = await object(StorageKeys.avatarImage(userId, id))
    await avatarRow(userId, id, served)
    await owner.query(`UPDATE users SET avatar_media_id = $1 WHERE id = $2`, [id, userId])

    await sweep(later())

    expect(await storage.head(uploaded)).toBeNull()
    expect(await storage.head(served)).not.toBeNull()
  })

  it.each(['infected', 'unscannable'])(
    'clears the pointer to a %s avatar and drops its row',
    async status => {
      const userId = randomUUID()
      const id = randomUUID()
      avatarUsers.push(userId)
      await owner.query(
        `INSERT INTO users (id, email, name, updated_at) VALUES ($1, $2, 'avatar owner', now())`,
        [userId, `it-avatar-${userId}@example.com`]
      )
      await avatarRow(userId, id, StorageKeys.avatar(userId, id, 'me.png'), status)
      await owner.query(`UPDATE users SET avatar_media_id = $1 WHERE id = $2`, [id, userId])

      await sweep()

      const user = await owner.query<{ avatar_media_id: string | null }>(
        `SELECT avatar_media_id FROM users WHERE id = $1`,
        [userId]
      )
      expect(user.rows[0]?.avatar_media_id).toBeNull()
      expect((await owner.query(`SELECT 1 FROM media WHERE id = $1`, [id])).rowCount).toBe(0)
    }
  )

  it('leaves a young avatar upload alone: a confirmation may be in flight', async () => {
    const young = await object(StorageKeys.avatarUpload(randomUUID(), randomUUID(), 'new.png'))

    await sweep()

    expect(await storage.head(young)).not.toBeNull()
  })

  it('leaves a young upload alone: a confirmation may be in flight', async () => {
    const young = await object(StorageKeys.messageUpload(storeId, randomUUID(), 'new.txt'))

    await sweep()

    expect(await storage.head(young)).not.toBeNull()
  })

  it('never touches what is not an upload or a message file', async () => {
    const exportKey = await object(StorageKeys.export(storeId, randomUUID(), 'x.csv'))

    await sweep(later())

    expect(await storage.head(exportKey)).not.toBeNull()
  })

  it('deletes the file an infected row left behind', async () => {
    const key = await object(StorageKeys.message(storeId, randomUUID(), 'virus.txt'))
    const id = await row('infected', key)
    await owner.query(`UPDATE media SET scanned_at = now() WHERE id = $1`, [id])

    const report = await sweep()

    expect(report.refusedFilesDeleted).toBeGreaterThanOrEqual(1)
    expect(await storage.head(key)).toBeNull()
  })

  // HC-122: a receipt or a statement is evidence of the books; a verdict never takes its file away
  it.each(['infected', 'unscannable'])(
    'keeps the file of a finance document marked %s',
    async status => {
      const key = await object(StorageKeys.message(storeId, randomUUID(), 'receipt.txt'))
      const id = await row(status, key)
      await owner.query(
        `UPDATE media SET scanned_at = now(), purpose = 'finance_document' WHERE id = $1`,
        [id]
      )

      await sweep()

      expect(await storage.head(key)).not.toBeNull()
    }
  )

  it('deletes the file an unscannable row left behind and never queues it again', async () => {
    const key = await object(StorageKeys.message(storeId, randomUUID(), 'unreadable.txt'))
    const id = await row('unscannable', key)
    await owner.query(`UPDATE media SET scanned_at = now() WHERE id = $1`, [id])

    const report = await sweep()

    expect(report.refusedFilesDeleted).toBeGreaterThanOrEqual(1)
    expect(await storage.head(key)).toBeNull()
    expect(await heavy.getJob(`${JobNames.SCAN_FILE}-${id}`)).toBeUndefined()
    expect(await mediaRowCount(id)).toBe(1)
  })

  it('queues the scan again for a pending row that never got one', async () => {
    const key = await object(StorageKeys.message(storeId, randomUUID(), 'lost.txt'))
    const id = await row('pending', key)

    await sweep()

    const queued = await heavy.getJob(`${JobNames.SCAN_FILE}-${id}`)
    expect(queued?.data).toEqual({ mediaId: id, storeId })
    // With the retry of every scan, so a sweep after an outage waits for the scanner as the first job did
    expect(queued?.opts).toMatchObject({
      attempts: ScanFileRetry.ATTEMPTS,
      backoff: { type: 'exponential', delay: ScanFileRetry.BACKOFF_MS }
    })
    await dropJob(queued)
  })

  it('drops a pending row whose file is gone once it is past the TTL', async () => {
    const id = await row('pending', StorageKeys.message(storeId, randomUUID(), 'gone.txt'))

    // Young: a confirmation may be mid-way, the row stays
    await sweep()
    expect(await mediaRowCount(id)).toBe(1)

    await sweep(later())
    expect(await mediaRowCount(id)).toBe(0)
  })

  // A run limited to some stores and users, for the suites that share the database and the bucket with
  // others. The schedule never passes one.
  describe('files an agent uploaded and never sent', () => {
    const unsentLater = () =>
      new Date(Date.now() + (UploadLimits.UNSENT_MESSAGE_FILE_TTL_HOURS + 1) * HOUR_MS)

    const uploader = randomUUID()
    const made: string[] = []
    afterEach(async () => {
      await owner.query(`DELETE FROM media WHERE id = ANY($1)`, [made.splice(0)])
      await owner.query(`DELETE FROM customers WHERE store_id = $1`, [storeId])
    })

    // A confirmed message file as the api leaves it: the agent uploaded it, no message, no customer and no delivery state yet
    async function unsent(
      overrides: {
        uploadedBy?: string | null
        deliveryStatus?: string | null
        customerId?: string | null
      } = {}
    ): Promise<{ id: string; key: string; thumb: string }> {
      const id = randomUUID()
      made.push(id)
      const key = await object(StorageKeys.message(storeId, id, 'u.png'))
      const thumb = await object(StorageKeys.messageVariant(storeId, id, 'thumb'))
      await owner.query(
        `INSERT INTO media (id, store_id, purpose, key, filename, content_type, file_size, status, variants,
                            uploaded_by, delivery_status, customer_id, created_at)
         VALUES ($1, $2, 'message', $3, 'u.png', 'image/png', 1, 'clean', $4::jsonb, $5, $6, $7, now() - interval '1 hour')`,
        [
          id,
          storeId,
          key,
          JSON.stringify({ thumb }),
          'uploadedBy' in overrides ? overrides.uploadedBy : uploader,
          overrides.deliveryStatus ?? null,
          overrides.customerId ?? null
        ]
      )
      return { id, key, thumb }
    }
    it('aborts and drops nothing when the store of an unsent file cannot be read', async () => {
      const file = await unsent()
      // Only the pass under test: the others would abort first or reach into the shared bucket
      const silenced = quiet(
        'deleteStrayObjects',
        'deleteStrayAvatarUploads',
        'dropUnattachedAvatars',
        'deleteRefusedFiles',
        'settleStuckScans'
      )
      const jobContext = moduleRef.get(JobContext, { strict: false })
      const failing = jest
        .spyOn(jobContext, 'forStore')
        .mockRejectedValue(new JobContextError('the context of the store could not be opened'))
      try {
        await expect(sweep(unsentLater())).rejects.toBeInstanceOf(SweepAbortError)
      } finally {
        failing.mockRestore()
        for (const spy of silenced) spy.mockRestore()
      }
      expect(await rowOf(file.id)).toBe(1)
      expect(await storage.head(file.key)).not.toBeNull()
    })

    const rowOf = async (id: string) =>
      (await owner.query(`SELECT 1 FROM media WHERE id = $1`, [id])).rows.length

    it('drops the row and every object of a file nobody sent once it is past the TTL', async () => {
      const file = await unsent()

      const report = await sweep(unsentLater())

      expect(report.unsentFilesDropped).toBe(1)
      expect(await rowOf(file.id)).toBe(0)
      expect(await storage.head(file.key)).toBeNull()
      expect(await storage.head(file.thumb)).toBeNull()
    })

    it('keeps a young file: an agent may be writing the message', async () => {
      const file = await unsent()

      const report = await sweep(new Date(Date.now() + HOUR_MS))

      expect(report.unsentFilesDropped).toBe(0)
      expect(await rowOf(file.id)).toBe(1)
      expect(await storage.head(file.key)).not.toBeNull()
    })

    it('keeps a file that has a customer (the message that carried it was deleted) and a file a customer sent', async () => {
      const customerId = randomUUID()
      await owner.query(
        `INSERT INTO customers (id, store_id, name, updated_at) VALUES ($1, $2, 'it-unsent', now())`,
        [customerId, storeId]
      )
      const withCustomer = await unsent({ customerId })
      const inbound = await unsent({ uploadedBy: null })

      const report = await sweep(unsentLater())

      expect(report.unsentFilesDropped).toBe(0)
      expect(await rowOf(withCustomer.id)).toBe(1)
      expect(await rowOf(inbound.id)).toBe(1)
    })

    it('does not touch a file of another purpose or of another store', async () => {
      const file = await unsent()
      await owner.query(`UPDATE media SET purpose = 'product' WHERE id = $1`, [file.id])

      const report = await cleaner.runScoped(
        { storeIds: [randomUUID()], userIds: [] },
        unsentLater()
      )

      expect(report.unsentFilesDropped).toBe(0)
      await sweep(unsentLater())
      expect(await rowOf(file.id)).toBe(1)
    })

    it('does not take a file that a message links at the same moment', async () => {
      const file = await unsent()
      const holder = new pg.Client({ connectionString: connectionUrls().owner })
      await holder.connect()
      try {
        // The agent's transaction holds the row (it is linking it); the sweep skips it instead of waiting
        await holder.query('BEGIN')
        await holder.query(`SELECT 1 FROM media WHERE id = $1 FOR UPDATE`, [file.id])

        const report = await sweep(unsentLater())

        expect(report.unsentFilesDropped).toBe(0)
        await holder.query('COMMIT')
      } finally {
        await holder.end()
      }
      expect(await rowOf(file.id)).toBe(1)
      expect(await storage.head(file.key)).not.toBeNull()
    })
  })

  describe('with a scope', () => {
    async function insertUser(id: string) {
      avatarUsers.push(id)
      await owner.query(
        `INSERT INTO users (id, email, name, updated_at) VALUES ($1, $2, 'avatar owner', now())`,
        [id, `it-avatar-${id}@example.com`]
      )
    }
    // A file and a row that belong to somebody else, put where the sweep would take them if it could
    async function somebodyElses() {
      const store = randomUUID()
      const user = randomUUID()
      const strayInStore = StorageKeys.messageUpload(store, randomUUID(), 'theirs.txt')
      const stagingOfUser = StorageKeys.avatarUpload(user, randomUUID(), 'theirs.png')
      for (const key of [strayInStore, stagingOfUser]) {
        await storage.put(key, Buffer.from('x'), 'text/plain')
        keys.push(key)
      }
      await insertUser(user)
      const looseId = randomUUID()
      const looseKey = StorageKeys.avatar(user, looseId, 'theirs.png')
      await storage.put(looseKey, Buffer.from('x'), 'image/png')
      keys.push(looseKey)
      await owner.query(
        `INSERT INTO media (id, store_id, purpose, uploaded_by, key, filename, content_type, file_size, status, created_at)
         VALUES ($1, NULL, 'avatar', $2, $3, 'me.png', 'image/png', 1, 'clean', now() - interval '3 days')`,
        [looseId, user, looseKey]
      )
      return { strayInStore, stagingOfUser, looseId, looseKey }
    }

    it('touches what is its own and leaves alone the objects and the rows of everybody else', async () => {
      const theirs = await somebodyElses()
      const ownStray = await object(StorageKeys.messageUpload(storeId, randomUUID(), 'mine.txt'))
      const ownStaging = await object(
        StorageKeys.avatarUpload(randomUUID(), randomUUID(), 'mine.png')
      )
      const ownUser = randomUUID()
      await insertUser(ownUser)
      const ownLoose = randomUUID()
      const ownLooseKey = await object(StorageKeys.avatar(ownUser, ownLoose, 'me.png'))
      await avatarRow(ownUser, ownLoose, ownLooseKey)

      await sweep(later())

      expect(await storage.head(ownStray)).toBeNull()
      expect(await storage.head(ownStaging)).toBeNull()
      expect(await storage.head(ownLooseKey)).toBeNull()
      expect(
        (await owner.query(`SELECT 1 FROM media WHERE id = $1`, [ownLoose])).rows
      ).toHaveLength(0)
      // Nothing of the others, though every one of these is old enough for the clock of the run
      expect(await storage.head(theirs.strayInStore)).not.toBeNull()
      expect(await storage.head(theirs.stagingOfUser)).not.toBeNull()
      expect(await storage.head(theirs.looseKey)).not.toBeNull()
      expect(
        (await owner.query(`SELECT 1 FROM media WHERE id = $1`, [theirs.looseId])).rows
      ).toHaveLength(1)
    })

    it('leaves alone the files and the scans of rows that are not its own', async () => {
      const otherUser = randomUUID()
      await insertUser(otherUser)
      const infectedKey = StorageKeys.avatar(otherUser, randomUUID(), 'bad.png')
      await storage.put(infectedKey, Buffer.from('x'), 'image/png')
      keys.push(infectedKey)
      await owner.query(
        `INSERT INTO media (id, store_id, purpose, uploaded_by, key, filename, content_type, file_size, status, scanned_at, created_at)
         VALUES ($1, NULL, 'avatar', $2, $3, 'bad.png', 'image/png', 1, 'infected', now(), now() - interval '2 hours')`,
        [randomUUID(), otherUser, infectedKey]
      )
      const mineKey = await object(StorageKeys.message(storeId, randomUUID(), 'bad.txt'))
      const mineId = await row('infected', mineKey)
      await owner.query(`UPDATE media SET scanned_at = now() WHERE id = $1`, [mineId])

      await sweep()

      expect(await storage.head(mineKey)).toBeNull()
      expect(await storage.head(infectedKey)).not.toBeNull()
    })

    it('does not clear the picture of somebody else, nor settle their scans', async () => {
      const other = randomUUID()
      await insertUser(other)
      const badId = randomUUID()
      const badKey = StorageKeys.avatar(other, badId, 'bad.png')
      await storage.put(badKey, Buffer.from('x'), 'image/png')
      keys.push(badKey)
      // An avatar the scan refused, three days old, that its owner had attached while it was pending
      await owner.query(
        `INSERT INTO media (id, store_id, purpose, uploaded_by, key, filename, content_type, file_size, status, scanned_at, created_at)
         VALUES ($1, NULL, 'avatar', $2, $3, 'bad.png', 'image/png', 1, 'unscannable', now() - interval '3 days', now() - interval '3 days')`,
        [badId, other, badKey]
      )
      await owner.query(`UPDATE users SET avatar_media_id = $1 WHERE id = $2`, [badId, other])
      // A pending avatar of somebody else whose file is gone, past the TTL: the sweep would drop its row
      const pendingId = randomUUID()
      await owner.query(
        `INSERT INTO media (id, store_id, purpose, uploaded_by, key, filename, content_type, file_size, status, created_at)
         VALUES ($1, NULL, 'avatar', $2, $3, 'p.png', 'image/png', 1, 'pending', now() - interval '3 days')`,
        [pendingId, other, StorageKeys.avatar(other, pendingId, 'gone.png')]
      )

      await sweep(later())

      const pointer = await owner.query<{ avatar_media_id: string | null }>(
        `SELECT avatar_media_id FROM users WHERE id = $1`,
        [other]
      )
      expect(pointer.rows[0]?.avatar_media_id).toBe(badId)
      expect(
        (await owner.query(`SELECT 1 FROM media WHERE id = ANY($1)`, [[badId, pendingId]])).rows
      ).toHaveLength(2)
      expect(await storage.head(badKey)).not.toBeNull()
    })

    it('asks the bucket only for the roots of its own stores and users; the schedule asks for the roots', async () => {
      const asked: string[] = []
      const listing = jest.spyOn(storage, 'list').mockImplementation(prefix => {
        asked.push(prefix)
        return Promise.resolve({ objects: [], next: undefined })
      })
      // The listings are what is under test: the passes over rows do not run, so that the run without a scope
      // does not look at the rows of the suites beside this one
      const quieted = quiet(
        'dropUnattachedAvatars',
        'deleteRefusedFiles',
        'dropUnsentMessageFiles',
        'settleStuckScans'
      )
      try {
        const user = randomUUID()
        const scope = { storeIds: [storeId], userIds: [user] }

        await cleaner.runScoped(scope, later())
        const scoped = asked.splice(0)
        await cleaner.run()
        const scheduled = asked.splice(0)

        expect(scoped.sort()).toEqual([`${STORES_ROOT}${storeId}/`, `${USERS_ROOT}${user}/`].sort())
        expect(scheduled.sort()).toEqual([STORES_ROOT, USERS_ROOT].sort())
      } finally {
        listing.mockRestore()
        for (const spy of quieted) spy.mockRestore()
      }
    })

    it('does not use, nor move, the cursor of the schedule', async () => {
      await redis.set(CacheKeys.mediaCleanup.cursor(), 'P3')
      await redis.set(CacheKeys.mediaCleanup.avatarCursor(), 'P5')

      await sweep(later())

      expect(await redis.get(CacheKeys.mediaCleanup.cursor())).toBe('P3')
      expect(await redis.get(CacheKeys.mediaCleanup.avatarCursor())).toBe('P5')
    })

    it('limits to nothing, not to everything, when it names nobody', async () => {
      const stray = await object(StorageKeys.messageUpload(storeId, randomUUID(), 'a.txt'))
      const staging = await object(StorageKeys.avatarUpload(randomUUID(), randomUUID(), 'a.png'))
      const stuck = await row(
        'pending',
        await object(StorageKeys.message(storeId, randomUUID(), 'p.txt'))
      )

      const theirs = await somebodyElses()

      const report = await cleaner.runScoped({ storeIds: [], userIds: [] }, later())

      expect(report).toEqual({
        objectsDeleted: 0,
        scansRequeued: 0,
        rowsDropped: 0,
        refusedFilesDeleted: 0,
        unsentFilesDropped: 0
      })
      expect(await storage.head(stray)).not.toBeNull()
      expect(await storage.head(staging)).not.toBeNull()
      expect(await storage.head(theirs.looseKey)).not.toBeNull()
      expect(
        (await owner.query(`SELECT 1 FROM media WHERE id = $1`, [theirs.looseId])).rows
      ).toHaveLength(1)
      expect((await owner.query(`SELECT 1 FROM media WHERE id = $1`, [stuck])).rows).toHaveLength(1)
    })

    it('refuses an id that is not an id, which would make a prefix that reaches more than its owner', async () => {
      for (const bad of ['', 'a/b', '..', 'not-a-uuid', '*']) {
        await expect(cleaner.runScoped({ storeIds: [bad], userIds: [] }, later())).rejects.toThrow()
        await expect(cleaner.runScoped({ storeIds: [], userIds: [bad] }, later())).rejects.toThrow()
      }
    })

    it('is not asked by the schedule: it sweeps the rows of everybody, as it did', async () => {
      const theirs = await somebodyElses()
      // The sweep of the avatars is under test; the others would reach the files and scans of other suites
      const quieted = quiet(
        'deleteStrayObjects',
        'deleteStrayAvatarUploads',
        'deleteRefusedFiles',
        'dropUnsentMessageFiles',
        'settleStuckScans'
      )

      try {
        await cleaner.run()
      } finally {
        for (const spy of quieted) spy.mockRestore()
      }

      // The row of an avatar nobody attached, three days old, goes whoever it is of
      expect(
        (await owner.query(`SELECT 1 FROM media WHERE id = $1`, [theirs.looseId])).rows
      ).toHaveLength(0)
      expect(await storage.head(theirs.looseKey)).toBeNull()
    })
  })
})
