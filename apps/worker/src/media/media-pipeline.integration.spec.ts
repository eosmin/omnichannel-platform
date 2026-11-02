import { randomUUID } from 'node:crypto'

import { getQueueToken } from '@nestjs/bullmq'
import { Test, type TestingModule } from '@nestjs/testing'
import type { Queue } from 'bullmq'
import pg from 'pg'
import sharp from 'sharp'

import { PrismaService } from '@platform/core/database'
import { connectionUrls } from '@platform/core/database-testing'
import { JobNames, QueueNames } from '@platform/core/queues'
import { ImageVariants, StorageKeys } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { dropJob } from '../testing/drop-job'
import { WorkerModule } from '../worker.module'

import { ClamavClient } from './clamav.client'
import { MediaPipeline } from './media-pipeline.service'

// The standard antivirus test string: every scanner flags it, and it is harmless
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'

// The scan and the variants against the real daemon, bucket and database: the chain of a file from
// `pending` to something that may be served, or to nothing.
describe('MediaPipeline', () => {
  let moduleRef: TestingModule
  let pipeline: MediaPipeline
  let storage: StorageService
  let prisma: PrismaService
  let heavy: Queue
  let owner: pg.Client
  const organizationId = randomUUID()
  const storeId = randomUUID()
  const keys: string[] = []

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [WorkerModule] })
      // The role of the worker, at the address of the run: the env file holds the one of a laptop
      .overrideProvider(PrismaService)
      .useValue(new PrismaService({ databaseUrl: connectionUrls().worker }))
      .compile()
    pipeline = moduleRef.get(MediaPipeline, { strict: false })
    storage = moduleRef.get(StorageService, { strict: false })
    prisma = moduleRef.get(PrismaService, { strict: false })
    heavy = moduleRef.get(getQueueToken(QueueNames.HEAVY_PROCESSING), { strict: false })
    owner = new pg.Client({ connectionString: connectionUrls().owner })
    await owner.connect()
    const slug = `it-media-${storeId.slice(0, 8)}`
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
    // Removing the organization removes the store and its media (cascade)
    await owner.query(`DELETE FROM organizations WHERE id = $1`, [organizationId])
    await owner.end()
    await moduleRef.close()
  })

  async function pendingMedia(
    filename: string,
    contentType: string,
    body: Buffer
  ): Promise<{ id: string; key: string }> {
    const id = randomUUID()
    const key = StorageKeys.message(storeId, id, filename)
    await storage.put(key, body, contentType)
    keys.push(
      key,
      ...Object.values(ImageVariants).map(variant =>
        StorageKeys.messageVariant(storeId, id, variant)
      )
    )
    // As the owner: the role of the worker reads and updates media, it never creates it
    await owner.query(
      `INSERT INTO media (id, store_id, purpose, key, filename, content_type, file_size, status)
       VALUES ($1, $2, 'message', $3, $4, $5, $6, 'pending')`,
      [id, storeId, key, filename, contentType, body.length]
    )
    return { id, key }
  }

  const png = (width: number, height: number): Promise<Buffer> =>
    sharp({ create: { width, height, channels: 3, background: '#3366cc' } })
      .png()
      .toBuffer()

  it('marks a clean image clean and queues its variants once', async () => {
    const media = await pendingMedia('photo.png', 'image/png', await png(3000, 2000))

    await pipeline.scan(media.id)
    // A repeated job (a retry after the first attempt died late) changes nothing
    await pipeline.scan(media.id)

    const row = await prisma.client.media.findUniqueOrThrow({ where: { id: media.id } })
    expect(row.status).toBe('clean')
    expect(row.scannedAt).not.toBeNull()
    const queued = await heavy.getJob(`${JobNames.PROCESS_IMAGE}-${media.id}`)
    expect(queued?.data).toEqual({ mediaId: media.id })
    await dropJob(queued)
  })

  it('deletes an infected file and never serves it', async () => {
    const media = await pendingMedia('invoice.txt', 'text/plain', Buffer.from(EICAR))

    await pipeline.scan(media.id)

    const row = await prisma.client.media.findUniqueOrThrow({ where: { id: media.id } })
    expect(row.status).toBe('infected')
    expect(row.scanResult).toEqual({ viruses: [expect.stringContaining('Eicar')] })
    expect(await storage.head(media.key)).toBeNull()
    expect(await heavy.getJob(`${JobNames.PROCESS_IMAGE}-${media.id}`)).toBeUndefined()
  })

  it('does not queue variants for a file that is not an image', async () => {
    const media = await pendingMedia('notes.txt', 'text/plain', Buffer.from('plain text'))

    await pipeline.scan(media.id)

    expect((await prisma.client.media.findUniqueOrThrow({ where: { id: media.id } })).status).toBe(
      'clean'
    )
    expect(await heavy.getJob(`${JobNames.PROCESS_IMAGE}-${media.id}`)).toBeUndefined()
  })

  it('makes the three WebP variants of a clean image and keeps their keys', async () => {
    const media = await pendingMedia('photo.png', 'image/png', await png(3000, 2000))
    await pipeline.scan(media.id)
    await dropJob(await heavy.getJob(`${JobNames.PROCESS_IMAGE}-${media.id}`))

    await pipeline.processImage(media.id)

    const row = await prisma.client.media.findUniqueOrThrow({ where: { id: media.id } })
    expect(row.processedAt).not.toBeNull()
    expect(row.variants).toEqual({
      full: StorageKeys.messageVariant(storeId, media.id, 'full'),
      medium: StorageKeys.messageVariant(storeId, media.id, 'medium'),
      thumb: StorageKeys.messageVariant(storeId, media.id, 'thumb')
    })
    const size = async (variant: 'full' | 'medium' | 'thumb') => {
      const bytes = await storage.read(StorageKeys.messageVariant(storeId, media.id, variant), 5e6)
      const meta = await sharp(bytes ?? Buffer.alloc(0)).metadata()
      return [meta.format, meta.width, meta.height]
    }
    expect(await size('full')).toEqual(['webp', 2000, 1333])
    expect(await size('medium')).toEqual(['webp', 800, 533])
    expect(await size('thumb')).toEqual(['webp', 160, 160])
  })

  it('leaves the image as it is when it cannot be decoded', async () => {
    const media = await pendingMedia('broken.png', 'image/png', Buffer.from('not an image'))
    await pipeline.scan(media.id)
    await dropJob(await heavy.getJob(`${JobNames.PROCESS_IMAGE}-${media.id}`))

    await expect(pipeline.processImage(media.id)).rejects.toThrow('could not be processed')

    const row = await prisma.client.media.findUniqueOrThrow({ where: { id: media.id } })
    expect(row.status).toBe('clean')
    expect(row.variants).toBeNull()
  })

  describe('a scan with no verdict', () => {
    let clamav: ClamavClient
    beforeEach(() => {
      clamav = moduleRef.get(ClamavClient, { strict: false })
      jest.spyOn(clamav, 'scan').mockRejectedValue(new Error('the daemon is down'))
    })
    afterEach(() => jest.restoreAllMocks())

    it('stays pending while the job has tries left, so the queue retries it', async () => {
      const media = await pendingMedia('retry.txt', 'text/plain', Buffer.from('plain text'))

      await expect(pipeline.scan(media.id, false)).rejects.toThrow('the daemon is down')

      const row = await prisma.client.media.findUniqueOrThrow({ where: { id: media.id } })
      expect(row.status).toBe('pending')
      expect(await storage.head(media.key)).not.toBeNull()
    })

    it('is given up on the last try: terminal row, file gone, error still raised', async () => {
      const media = await pendingMedia('lost.txt', 'text/plain', Buffer.from('plain text'))

      await expect(pipeline.scan(media.id, true)).rejects.toThrow('the daemon is down')

      const row = await prisma.client.media.findUniqueOrThrow({ where: { id: media.id } })
      expect(row.status).toBe('unscannable')
      expect(row.scannedAt).not.toBeNull()
      expect(await storage.head(media.key)).toBeNull()
      // Past its state: a later job does nothing, not even ask the daemon
      await expect(pipeline.scan(media.id, true)).resolves.toBeUndefined()
    })
  })

  // The picture of a person: no store, and never served as it was uploaded
  describe('an avatar', () => {
    const userIds: string[] = []
    afterEach(async () => {
      const ids = userIds.splice(0)
      await owner.query(`DELETE FROM media WHERE uploaded_by = ANY($1)`, [ids])
      await owner.query(`DELETE FROM users WHERE id = ANY($1)`, [ids])
    })

    // A photo that carries metadata, which is what must not reach the people who see the picture
    const photoWithMetadata = (): Promise<Buffer> =>
      sharp({ create: { width: 800, height: 400, channels: 3, background: '#cc6633' } })
        .withExif({ IFD0: { ImageDescription: 'taken at 19.4326,-99.1332' } })
        .jpeg()
        .toBuffer()

    async function pendingAvatar(body: Buffer, contentType = 'image/jpeg') {
      const userId = randomUUID()
      const id = randomUUID()
      userIds.push(userId)
      await owner.query(
        `INSERT INTO users (id, email, name, updated_at) VALUES ($1, $2, 'avatar owner', now())`,
        [userId, `it-avatar-${userId}@example.com`]
      )
      const key = StorageKeys.avatar(userId, id, 'me.jpg')
      await storage.put(key, body, contentType)
      keys.push(key, StorageKeys.avatarImage(userId, id))
      await owner.query(
        `INSERT INTO media (id, store_id, purpose, uploaded_by, key, filename, content_type, file_size, status)
         VALUES ($1, NULL, 'avatar', $2, $3, 'me.jpg', $4, $5, 'pending')`,
        [id, userId, key, contentType, body.length]
      )
      return { id, userId, key }
    }

    it('is scanned, then re-encoded to a small square WebP with no metadata, and the upload goes', async () => {
      const original = await photoWithMetadata()
      expect((await sharp(original).metadata()).exif).toBeDefined()
      const avatar = await pendingAvatar(original)

      await pipeline.scan(avatar.id)
      await dropJob(await heavy.getJob(`${JobNames.PROCESS_IMAGE}-${avatar.id}`))
      await pipeline.processImage(avatar.id)

      const row = await prisma.client.media.findUniqueOrThrow({ where: { id: avatar.id } })
      const served = StorageKeys.avatarImage(avatar.userId, avatar.id)
      expect(row).toMatchObject({
        status: 'clean',
        key: served,
        filename: 'avatar.webp',
        contentType: 'image/webp',
        storeId: null
      })
      expect(row.processedAt).not.toBeNull()
      const bytes = await storage.read(served, 5e6)
      const meta = await sharp(bytes ?? Buffer.alloc(0)).metadata()
      expect([meta.format, meta.width, meta.height]).toEqual(['webp', 256, 256])
      expect(meta.exif).toBeUndefined()
      expect(bytes?.length).toBe(row.fileSize)
      expect(await storage.head(avatar.key)).toBeNull()
    })

    it('is processed once: a repeated job changes nothing', async () => {
      const avatar = await pendingAvatar(await photoWithMetadata())
      await pipeline.scan(avatar.id)
      await dropJob(await heavy.getJob(`${JobNames.PROCESS_IMAGE}-${avatar.id}`))
      await pipeline.processImage(avatar.id)
      const first = await prisma.client.media.findUniqueOrThrow({ where: { id: avatar.id } })

      await pipeline.processImage(avatar.id)

      const again = await prisma.client.media.findUniqueOrThrow({ where: { id: avatar.id } })
      expect(again.processedAt).toEqual(first.processedAt)
    })

    it('is refused for good when it cannot be re-encoded: never served, file gone', async () => {
      const avatar = await pendingAvatar(Buffer.from('not an image'))
      await pipeline.scan(avatar.id)
      await dropJob(await heavy.getJob(`${JobNames.PROCESS_IMAGE}-${avatar.id}`))

      await expect(pipeline.processImage(avatar.id)).resolves.toBeUndefined()

      const row = await prisma.client.media.findUniqueOrThrow({ where: { id: avatar.id } })
      expect(row.status).toBe('unscannable')
      expect(row.processedAt).toBeNull()
      expect(await storage.head(avatar.key)).toBeNull()
    })

    it('leaves nothing behind when the person replaced it while it was processed', async () => {
      const avatar = await pendingAvatar(await photoWithMetadata())
      await pipeline.scan(avatar.id)
      await dropJob(await heavy.getJob(`${JobNames.PROCESS_IMAGE}-${avatar.id}`))
      // The person's replacement deletes the row after the worker read it and before it wrote
      const put = storage.put.bind(storage)
      const spy = jest.spyOn(storage, 'put').mockImplementationOnce(async (...args) => {
        await put(...args)
        await owner.query(`DELETE FROM media WHERE id = $1`, [avatar.id])
      })
      try {
        await pipeline.processImage(avatar.id)
      } finally {
        spy.mockRestore()
      }

      expect(await storage.head(StorageKeys.avatarImage(avatar.userId, avatar.id))).toBeNull()
    })

    it('is not processed when its key is not under its own user', async () => {
      const avatar = await pendingAvatar(await photoWithMetadata())
      await pipeline.scan(avatar.id)
      await dropJob(await heavy.getJob(`${JobNames.PROCESS_IMAGE}-${avatar.id}`))
      await owner.query(`UPDATE media SET uploaded_by = NULL WHERE id = $1`, [avatar.id])

      await pipeline.processImage(avatar.id)

      const row = await prisma.client.media.findUniqueOrThrow({ where: { id: avatar.id } })
      expect(row.processedAt).toBeNull()
      expect(row.status).toBe('unscannable')
    })

    it('fails (to be tried again) when its file is missing but the row is there', async () => {
      const avatar = await pendingAvatar(await photoWithMetadata())
      await pipeline.scan(avatar.id)
      await dropJob(await heavy.getJob(`${JobNames.PROCESS_IMAGE}-${avatar.id}`))
      await storage.delete(avatar.key)

      await expect(pipeline.processImage(avatar.id)).rejects.toThrow('not in the bucket')
    })

    it('is refused when it declares more pixels than an avatar needs', async () => {
      const huge = await sharp({
        create: { width: 6000, height: 5000, channels: 3, background: '#000' }
      })
        .png({ compressionLevel: 9 })
        .toBuffer()
      const avatar = await pendingAvatar(huge, 'image/png')
      await pipeline.scan(avatar.id)
      await dropJob(await heavy.getJob(`${JobNames.PROCESS_IMAGE}-${avatar.id}`))

      await pipeline.processImage(avatar.id)

      const row = await prisma.client.media.findUniqueOrThrow({ where: { id: avatar.id } })
      expect(row.status).toBe('unscannable')
    })
  })

  it('does nothing for a media that was deleted or is not pending', async () => {
    await expect(pipeline.scan(randomUUID())).resolves.toBeUndefined()
    await expect(pipeline.processImage(randomUUID())).resolves.toBeUndefined()
  })
})
