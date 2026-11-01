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

import { WorkerModule } from '../worker.module'

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
    await queued?.remove()
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
    await (await heavy.getJob(`${JobNames.PROCESS_IMAGE}-${media.id}`))?.remove()

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
    await (await heavy.getJob(`${JobNames.PROCESS_IMAGE}-${media.id}`))?.remove()

    await expect(pipeline.processImage(media.id)).rejects.toThrow('could not be processed')

    const row = await prisma.client.media.findUniqueOrThrow({ where: { id: media.id } })
    expect(row.status).toBe('clean')
    expect(row.variants).toBeNull()
  })

  it('does nothing for a media that was deleted or is not pending', async () => {
    await expect(pipeline.scan(randomUUID())).resolves.toBeUndefined()
    await expect(pipeline.processImage(randomUUID())).resolves.toBeUndefined()
  })
})
