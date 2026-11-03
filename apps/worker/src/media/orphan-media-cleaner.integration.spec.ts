import { randomUUID } from 'node:crypto'

import { getQueueToken } from '@nestjs/bullmq'
import { Test, type TestingModule } from '@nestjs/testing'
import type { Queue } from 'bullmq'
import type { Redis } from 'ioredis'
import pg from 'pg'

import { CacheKeys } from '@platform/core/cache'
import { PrismaService } from '@platform/core/database'
import { connectionUrls } from '@platform/core/database-testing'
import { JobNames, QueueNames } from '@platform/core/queues'
import { REDIS_CLIENT } from '@platform/core/redis'
import { StorageKeys, UploadLimits, USERS_ROOT } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { dropJob } from '../testing/drop-job'
import { WorkerModule } from '../worker.module'

import { OrphanMediaCleaner } from './orphan-media-cleaner.service'

const HOUR_MS = 3_600_000

// What a failure half way through leaves behind, against the real bucket, database and queue. The
// cleaner is run "in the future" instead of waiting a day: objects cannot be given an old date.
describe('OrphanMediaCleaner', () => {
  let moduleRef: TestingModule
  let cleaner: OrphanMediaCleaner
  let storage: StorageService
  let prisma: PrismaService
  let heavy: Queue
  let owner: pg.Client
  let redis: Redis
  const organizationId = randomUUID()
  const storeId = randomUUID()
  const keys: string[] = []
  const later = () =>
    new Date(Date.now() + (UploadLimits.UNCONFIRMED_UPLOAD_TTL_HOURS + 1) * HOUR_MS)

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(PrismaService)
      .useValue(new PrismaService({ databaseUrl: connectionUrls().worker }))
      .compile()
    cleaner = moduleRef.get(OrphanMediaCleaner, { strict: false })
    storage = moduleRef.get(StorageService, { strict: false })
    prisma = moduleRef.get(PrismaService, { strict: false })
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

    await cleaner.run(later())

    expect(await storage.head(stray)).toBeNull()
    expect(await storage.head(strayFinal)).toBeNull()
    expect(await storage.head(keptKey)).not.toBeNull()
  })

  it('deletes the variants of a media that no longer exists, and keeps those of one that does', async () => {
    const goneId = randomUUID()
    const goneVariant = await object(StorageKeys.messageVariant(storeId, goneId, 'thumb'))
    const aliveKey = await object(StorageKeys.message(storeId, randomUUID(), 'd.png'))
    const aliveId = aliveKey.split('/')[3] ?? ''
    await row('clean', aliveKey, aliveId)
    const aliveVariant = await object(StorageKeys.messageVariant(storeId, aliveId, 'thumb'))

    await cleaner.run(later())

    expect(await storage.head(goneVariant)).toBeNull()
    expect(await storage.head(aliveVariant)).not.toBeNull()
  })

  it('deletes the staging copy of a media that was confirmed', async () => {
    const id = randomUUID()
    const staging = await object(StorageKeys.messageUpload(storeId, id, 'e.txt'))
    await row('clean', StorageKeys.message(storeId, id, 'e.txt'), id)

    await cleaner.run(later())

    expect(await storage.head(staging)).toBeNull()
  })

  it('deletes the staging file of an avatar nobody confirmed', async () => {
    const staging = await object(StorageKeys.avatarUpload(randomUUID(), randomUUID(), 'me.png'))

    await cleaner.run(later())

    expect(await storage.head(staging)).toBeNull()
  })

  // The users these cases make go with their rows, whether the case passed or not
  const avatarUsers: string[] = []
  afterEach(async () => {
    const ids = avatarUsers.splice(0)
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

    await cleaner.run()

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

    await cleaner.run()

    expect(await storage.head(freshKey)).not.toBeNull()
    const rows = await owner.query(`SELECT id FROM media WHERE id = $1`, [freshId])
    expect(rows.rows).toHaveLength(1)
  })

  it('resumes the sweep of stray avatar uploads from where the last run stopped', async () => {
    // The bucket is shared with other suites, so the listing of the users root is replaced by one of
    // our own: a long run of empty pages, and the stray staging object on the page after the cap
    const stray = StorageKeys.avatarUpload(randomUUID(), randomUUID(), 'old.png')
    const lastPage = UploadLimits.ORPHAN_LIST_PAGES_PER_RUN
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
      await cleaner.run(later())

      expect(asked).toHaveLength(lastPage)
      expect(deleting).not.toHaveBeenCalledWith(stray)
      expect(await redis.get(CacheKeys.mediaCleanup.avatarCursor())).toBe(`P${lastPage}`)

      asked.length = 0
      await cleaner.run(later())

      expect(asked[0]).toBe(`P${lastPage}`)
      expect(deleting).toHaveBeenCalledWith(stray)
      expect(await redis.get(CacheKeys.mediaCleanup.avatarCursor())).toBeNull()
    } finally {
      listing.mockRestore()
      deleting.mockRestore()
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

    await cleaner.run(later())

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

    await cleaner.run(later())

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

      await cleaner.run()

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

    await cleaner.run()

    expect(await storage.head(young)).not.toBeNull()
  })

  it('leaves a young upload alone: a confirmation may be in flight', async () => {
    const young = await object(StorageKeys.messageUpload(storeId, randomUUID(), 'new.txt'))

    await cleaner.run()

    expect(await storage.head(young)).not.toBeNull()
  })

  it('never touches what is not an upload or a message file', async () => {
    const exportKey = await object(StorageKeys.export(storeId, randomUUID(), 'x.csv'))

    await cleaner.run(later())

    expect(await storage.head(exportKey)).not.toBeNull()
  })

  it('deletes the file an infected row left behind', async () => {
    const key = await object(StorageKeys.message(storeId, randomUUID(), 'virus.txt'))
    const id = await row('infected', key)
    await owner.query(`UPDATE media SET scanned_at = now() WHERE id = $1`, [id])

    const report = await cleaner.run()

    expect(report.infectedFilesDeleted).toBeGreaterThanOrEqual(1)
    expect(await storage.head(key)).toBeNull()
  })

  it('deletes the file an unscannable row left behind and never queues it again', async () => {
    const key = await object(StorageKeys.message(storeId, randomUUID(), 'unreadable.txt'))
    const id = await row('unscannable', key)
    await owner.query(`UPDATE media SET scanned_at = now() WHERE id = $1`, [id])

    const report = await cleaner.run()

    expect(report.infectedFilesDeleted).toBeGreaterThanOrEqual(1)
    expect(await storage.head(key)).toBeNull()
    expect(await heavy.getJob(`${JobNames.SCAN_FILE}-${id}`)).toBeUndefined()
    expect(await prisma.client.media.findUnique({ where: { id } })).not.toBeNull()
  })

  it('queues the scan again for a pending row that never got one', async () => {
    const key = await object(StorageKeys.message(storeId, randomUUID(), 'lost.txt'))
    const id = await row('pending', key)

    await cleaner.run()

    const queued = await heavy.getJob(`${JobNames.SCAN_FILE}-${id}`)
    expect(queued?.data).toEqual({ mediaId: id })
    await dropJob(queued)
  })

  it('drops a pending row whose file is gone once it is past the TTL', async () => {
    const id = await row('pending', StorageKeys.message(storeId, randomUUID(), 'gone.txt'))

    // Young: a confirmation may be mid-way, the row stays
    await cleaner.run()
    expect(await prisma.client.media.findUnique({ where: { id } })).not.toBeNull()

    await cleaner.run(later())
    expect(await prisma.client.media.findUnique({ where: { id } })).toBeNull()
  })
})
