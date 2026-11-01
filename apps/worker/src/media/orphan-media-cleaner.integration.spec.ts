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
import { StorageKeys, UploadLimits } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

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

  it('queues the scan again for a pending row that never got one', async () => {
    const key = await object(StorageKeys.message(storeId, randomUUID(), 'lost.txt'))
    const id = await row('pending', key)

    await cleaner.run()

    const queued = await heavy.getJob(`${JobNames.SCAN_FILE}-${id}`)
    expect(queued?.data).toEqual({ mediaId: id })
    await queued?.remove()
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
