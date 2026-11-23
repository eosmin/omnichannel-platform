import type { Queue } from 'bullmq'
import type { PinoLogger } from 'nestjs-pino'

import type { PrismaService } from '@platform/core/database'
import type { DomainEvents } from '@platform/core/event-bus'
import type { ProcessImageJob } from '@platform/core/queues'
import { AvSanitizing } from '@platform/core/storage'
import type { StorageService } from '@platform/core/storage-module'

import type { CleanedAv } from './av-cleaner'
import type { ClamavClient } from './clamav.client'
import { MediaPipeline } from './media-pipeline.service'
import { InlineDocumentCleaner } from './testing/inline-document-cleaner'

const ORIGINAL = Buffer.from('original clip with its place')
const CLEANED = Buffer.from('clean clip')
const VERSION = { [AvSanitizing.CLEANING_VERSION_KEY]: AvSanitizing.CLEANING_VERSION }

// Step 7.1-J-2: a video or an audio file loses its container metadata on the scan, before the row is `clean` (only a clean row is sent,
// opened or signed). Nothing is refused or lost; a machine that cannot clean never lets an uploaded file leave
describe('MediaPipeline and the metadata of video and audio', () => {
  function build(
    over: { contentType?: string; uploadedBy?: string | null; scanResult?: unknown } = {}
  ) {
    const updateMany = jest
      .fn<Promise<{ count: number }>, [unknown]>()
      .mockResolvedValue({ count: 1 })
    const prisma = {
      client: {
        media: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'media-1',
            storeId: 'store-1',
            key: 'stores/s/clip.mp4',
            contentType: over.contentType ?? 'video/mp4',
            purpose: 'message',
            uploadedBy: over.uploadedBy === undefined ? null : over.uploadedBy,
            status: 'pending',
            processedAt: null,
            scanResult: over.scanResult ?? null,
            messageId: null,
            origin: null
          }),
          updateMany
        }
      },
      transaction: jest.fn()
    }
    const storage = {
      stream: jest.fn().mockResolvedValue('body'),
      read: jest.fn().mockResolvedValue(ORIGINAL),
      put: jest.fn<Promise<void>, [string, Buffer, string]>().mockResolvedValue(undefined),
      delete: jest.fn()
    }
    const logger = { setContext: jest.fn(), warn: jest.fn(), error: jest.fn() }
    const clean = jest.fn<Promise<CleanedAv>, [Buffer, string, string]>()
    const inc = jest.fn()
    const pipeline = new MediaPipeline(
      prisma as unknown as PrismaService,
      storage as unknown as StorageService,
      { scan: jest.fn().mockResolvedValue({ infected: false }) } as unknown as ClamavClient,
      { publish: jest.fn() } as unknown as DomainEvents,
      { add: jest.fn() } as unknown as Queue<ProcessImageJob>,
      logger as unknown as PinoLogger,
      { forStore: (_id: string, work: () => Promise<unknown>) => work() } as never,
      new InlineDocumentCleaner(),
      { clean },
      { inc } as never
    )
    return { pipeline, storage, updateMany, clean, inc, logger }
  }
  const scope = { storeId: 'store-1' }
  const wroteClean = (updateMany: jest.Mock): boolean =>
    updateMany.mock.calls.some(
      ([arg]) => (arg as { data?: { status?: string } }).data?.status === 'clean'
    )

  it('writes the cleaned file, makes the size and the mark true, and only then marks the row clean', async () => {
    const { pipeline, storage, updateMany, clean, inc } = build()
    clean.mockResolvedValue({ kind: 'cleaned', body: CLEANED, hadMetadata: true })
    await pipeline.scan('media-1', scope)
    expect(clean).toHaveBeenCalledWith(ORIGINAL, 'video/mp4', 'media-1')
    expect(storage.put).toHaveBeenCalledWith('stores/s/clip.mp4', CLEANED, 'video/mp4')
    expect(updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: 'media-1', status: 'pending' },
      data: { fileSize: CLEANED.length, scanResult: { sanitized: true, ...VERSION } }
    })
    expect(updateMany.mock.calls.at(-1)?.[0]).toMatchObject({ data: { status: 'clean' } })
    expect(inc).toHaveBeenCalledWith({ result: 'cleaned' })
  })

  it('keeps a file it cannot clean without risk, marks it, and still marks the row clean', async () => {
    const { pipeline, storage, updateMany, clean, inc } = build()
    clean.mockResolvedValue({ kind: 'untouched', why: 'not_cleanable' })
    await pipeline.scan('media-1', scope)
    expect(storage.put).not.toHaveBeenCalled()
    expect(updateMany.mock.calls[0]?.[0]).toMatchObject({
      data: { fileSize: ORIGINAL.length, scanResult: { avCleaning: 'not_cleanable', ...VERSION } }
    })
    expect(wroteClean(updateMany)).toBe(true)
    expect(inc).toHaveBeenCalledWith({ result: 'not_cleanable' })
  })

  it('does not copy a file again when its row carries the mark of this version', async () => {
    const { pipeline, clean, storage, updateMany } = build({
      scanResult: { sanitized: true, ...VERSION }
    })
    await pipeline.scan('media-1', scope)
    expect(clean).not.toHaveBeenCalled()
    expect(storage.put).not.toHaveBeenCalled()
    expect(wroteClean(updateMany)).toBe(true)
  })

  it('takes a file again whose mark is of another version', async () => {
    const { pipeline, clean } = build({ scanResult: { sanitized: true, cleaningVersion: 0 } })
    clean.mockResolvedValue({ kind: 'untouched', why: 'timed_out' })
    await pipeline.scan('media-1', scope)
    expect(clean).toHaveBeenCalledTimes(1)
  })

  it('lets the queue retry an error of the machine and marks nothing', async () => {
    const { pipeline, clean, updateMany, storage, inc } = build({ uploadedBy: 'user-1' })
    clean.mockRejectedValue(new Error('the video and audio tools could not be started'))
    await expect(pipeline.scan('media-1', scope, false)).rejects.toThrow('could not be started')
    expect(updateMany).not.toHaveBeenCalled()
    expect(storage.put).not.toHaveBeenCalled()
    expect(inc).not.toHaveBeenCalled()
  })

  it('NEVER lets an uploaded file go clean when the tools failed on every attempt: it stays pending', async () => {
    const { pipeline, clean, updateMany, storage, inc, logger } = build({ uploadedBy: 'user-1' })
    clean.mockRejectedValue(new Error('the video and audio tools could not be started'))
    await expect(pipeline.scan('media-1', scope, true)).rejects.toThrow('could not be started')
    expect(updateMany).not.toHaveBeenCalled()
    expect(wroteClean(updateMany)).toBe(false)
    expect(storage.put).not.toHaveBeenCalled()
    expect(inc).toHaveBeenCalledWith({ result: 'av_unavailable' })
    expect(logger.error).toHaveBeenCalledTimes(1)
  })

  it('keeps an inbound file as it came, marked av_unavailable, when the tools failed on every attempt', async () => {
    const { pipeline, clean, updateMany, storage, inc } = build({ uploadedBy: null })
    clean.mockRejectedValue(new Error('the video and audio tools could not be started'))
    await pipeline.scan('media-1', scope, true)
    expect(storage.put).not.toHaveBeenCalled()
    expect(updateMany.mock.calls[0]?.[0]).toMatchObject({
      data: { scanResult: { avCleaning: 'av_unavailable', ...VERSION } }
    })
    expect(wroteClean(updateMany)).toBe(true)
    expect(inc).toHaveBeenCalledWith({ result: 'av_unavailable' })
    expect(inc).toHaveBeenCalledTimes(1)
  })

  it('does not mark clean when the bucket refuses the write', async () => {
    const { pipeline, clean, updateMany, storage } = build()
    clean.mockResolvedValue({ kind: 'cleaned', body: CLEANED, hadMetadata: true })
    storage.put.mockRejectedValue(new Error('bucket down'))
    await expect(pipeline.scan('media-1', scope)).rejects.toThrow('bucket down')
    expect(updateMany).not.toHaveBeenCalled()
  })

  it('stops, counting nothing, when the row moved on while the file was cleaned', async () => {
    const { pipeline, clean, updateMany, inc } = build()
    clean.mockResolvedValue({ kind: 'cleaned', body: CLEANED, hadMetadata: false })
    updateMany.mockResolvedValue({ count: 0 })
    await pipeline.scan('media-1', scope)
    expect(updateMany).toHaveBeenCalledTimes(1)
    expect(inc).not.toHaveBeenCalled()
  })

  it.each(['application/pdf', 'image/png'])(
    'does not hand a %s to the video and audio cleaner',
    async type => {
      const { pipeline, clean } = build({ contentType: type })
      await pipeline.scan('media-1', scope).catch(() => undefined)
      expect(clean).not.toHaveBeenCalled()
    }
  )
})
