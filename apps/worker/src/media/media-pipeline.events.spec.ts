import type { Queue } from 'bullmq'
import type { PinoLogger } from 'nestjs-pino'
import sharp from 'sharp'

import type { PrismaService } from '@platform/core/database'
import type { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import type { ProcessImageJob } from '@platform/core/queues'
import type { StorageService } from '@platform/core/storage-module'

import type { ClamavClient } from './clamav.client'
import { MediaPipeline } from './media-pipeline.service'

const STORE = '11111111-1111-4111-8111-111111111111'
const MESSAGE = '22222222-2222-4222-8222-222222222222'

// What the thread hears of a file: a verdict on a file of a message is announced, a verdict on a file
// that is still in the composer is not (nothing draws it yet).
describe('MediaPipeline announcements', () => {
  const publish = jest.fn<void, [unknown, string, unknown]>()
  const claim = jest.fn()
  const media = (messageId: string | null, originMessageId: string | null = null) => ({
    id: 'media-1',
    storeId: STORE,
    messageId,
    origin: originMessageId === null ? null : { messageId: originMessageId },
    key: 'k',
    contentType: 'text/plain',
    status: 'pending',
    processedAt: null
  })

  function build(row: ReturnType<typeof media>, infected: boolean): MediaPipeline {
    const tx = {
      message: {
        findFirst: jest.fn().mockResolvedValue({
          conversationId: 'c1',
          type: 'text',
          conversation: { status: 'open', assignedTo: null }
        })
      }
    }
    const prisma = {
      client: {
        media: {
          findUnique: jest.fn().mockResolvedValue(row),
          updateMany: claim.mockResolvedValue({ count: 1 })
        }
      },
      transaction: (run: (t: typeof tx) => Promise<void>) => run(tx)
    }
    const storage = { stream: jest.fn().mockResolvedValue('body'), delete: jest.fn() }
    const clamav = {
      scan: jest
        .fn()
        .mockResolvedValue(infected ? { infected: true, viruses: ['x'] } : { infected: false })
    }
    const logger = { setContext: jest.fn(), warn: jest.fn() }
    return new MediaPipeline(
      prisma as unknown as PrismaService,
      storage as unknown as StorageService,
      clamav as unknown as ClamavClient,
      { publish } as unknown as DomainEvents,
      { add: jest.fn() } as unknown as Queue<ProcessImageJob>,
      logger as unknown as PinoLogger
    )
  }

  beforeEach(() => {
    publish.mockClear()
  })

  it('announces a clean file of a message', async () => {
    await build(media(MESSAGE), false).scan('media-1')
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish.mock.calls[0]?.[1]).toBe(Events.MEDIA_PROCESSED)
  })

  it('announces an infected file of a message', async () => {
    await build(media(MESSAGE), true).scan('media-1')
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish.mock.calls[0]?.[1]).toBe(Events.MEDIA_INFECTED)
  })

  it('announces the picture of an ad as the message that carried it', async () => {
    await build(media(null, MESSAGE), false).scan('media-1')
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish.mock.calls[0]?.[1]).toBe(Events.MEDIA_PROCESSED)
    expect(publish.mock.calls[0]?.[2]).toMatchObject({ storeId: STORE, messageId: MESSAGE })
  })

  it('announces an infected picture of an ad too, so the card drops its placeholder', async () => {
    await build(media(null, MESSAGE), true).scan('media-1')
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish.mock.calls[0]?.[1]).toBe(Events.MEDIA_INFECTED)
  })

  it('announces nothing for a file that belongs to no message', async () => {
    await build(media(null), false).scan('media-1')
    expect(publish).not.toHaveBeenCalled()
  })

  // The variants of a picture never come when the decoder refuses it: the thread must hear that it is
  // settled, or its placeholder would wait for ever
  describe('an image the decoder refuses', () => {
    function buildRefusing(settled: number): { pipeline: MediaPipeline; update: jest.Mock } {
      const update = jest.fn().mockResolvedValue({ count: settled })
      const row = { ...media(MESSAGE), contentType: 'image/png', status: 'clean' }
      const tx = {
        message: {
          findFirst: jest.fn().mockResolvedValue({
            conversationId: 'c1',
            type: 'image',
            conversation: { status: 'open', assignedTo: null }
          })
        }
      }
      const prisma = {
        client: { media: { findUnique: jest.fn().mockResolvedValue(row), updateMany: update } },
        transaction: (run: (t: typeof tx) => Promise<void>) => run(tx)
      }
      const storage = { read: jest.fn().mockResolvedValue(Buffer.from('not an image')) }
      const logger = { setContext: jest.fn(), warn: jest.fn() }
      const pipeline = new MediaPipeline(
        prisma as unknown as PrismaService,
        storage as unknown as StorageService,
        {} as unknown as ClamavClient,
        { publish } as unknown as DomainEvents,
        { add: jest.fn() } as unknown as Queue<ProcessImageJob>,
        logger as unknown as PinoLogger
      )
      return { pipeline, update }
    }

    it('settles the row, announces it once and still fails the job', async () => {
      const { pipeline, update } = buildRefusing(1)

      await expect(pipeline.processImage('media-1')).rejects.toThrow('could not be processed')

      expect(update).toHaveBeenCalledTimes(1)
      const [args] = update.mock.calls[0] as [{ where: object; data: { processedAt: unknown } }]
      expect(args.where).toEqual({ id: 'media-1', status: 'clean', processedAt: null })
      expect(args.data.processedAt).toBeInstanceOf(Date)
      expect(publish).toHaveBeenCalledTimes(1)
      expect(publish.mock.calls[0]?.[1]).toBe(Events.MEDIA_PROCESSED)
    })

    it('announces nothing when another attempt already settled it', async () => {
      const { pipeline } = buildRefusing(0)

      await expect(pipeline.processImage('media-1')).rejects.toThrow('could not be processed')

      expect(publish).not.toHaveBeenCalled()
    })
  })

  // The variants of a picture the decoder takes: what the end of the job does with the row and the bucket
  describe('the variants of a picture', () => {
    const png = () =>
      sharp({ create: { width: 64, height: 64, channels: 3, background: '#3366cc' } })
        .png()
        .toBuffer()

    async function build(options: { settled: number; rowGone: boolean; putFails?: Error }) {
      const row = { ...media(MESSAGE), contentType: 'image/png', status: 'clean' }
      const findUnique = jest.fn().mockResolvedValueOnce(row)
      // After the first read, the row is there or not
      findUnique.mockResolvedValue(options.rowGone ? null : row)
      const update = jest.fn().mockResolvedValue({ count: options.settled })
      const tx = {
        message: {
          findFirst: jest.fn().mockResolvedValue({
            conversationId: 'c1',
            type: 'image',
            conversation: { status: 'open', assignedTo: null }
          })
        }
      }
      const prisma = {
        client: { media: { findUnique, updateMany: update } },
        transaction: (run: (t: typeof tx) => Promise<void>) => run(tx)
      }
      const put = jest.fn()
      if (options.putFails) put.mockRejectedValue(options.putFails)
      const remove = jest.fn().mockResolvedValue(undefined)
      const storage = { read: jest.fn().mockResolvedValue(await png()), put, delete: remove }
      const logger = { setContext: jest.fn(), warn: jest.fn() }
      const pipeline = new MediaPipeline(
        prisma as unknown as PrismaService,
        storage as unknown as StorageService,
        {} as unknown as ClamavClient,
        { publish } as unknown as DomainEvents,
        { add: jest.fn() } as unknown as Queue<ProcessImageJob>,
        logger as unknown as PinoLogger
      )
      return { pipeline, update, put, remove }
    }

    it('writes them under the keys of the row, guarded by the state of the row, and announces once', async () => {
      const { pipeline, update, put, remove } = await build({ settled: 1, rowGone: false })

      await pipeline.processImage('media-1')

      expect(put).toHaveBeenCalledTimes(3)
      const [args] = update.mock.calls[0] as [{ where: object; data: { variants: object } }]
      expect(args.where).toEqual({ id: 'media-1', status: 'clean', processedAt: null })
      expect(Object.keys(args.data.variants).sort()).toEqual(['full', 'medium', 'thumb'])
      expect(remove).not.toHaveBeenCalled()
      expect(publish).toHaveBeenCalledTimes(1)
      expect(publish.mock.calls[0]?.[1]).toBe(Events.MEDIA_PROCESSED)
      expect(publish.mock.calls[0]?.[2]).toMatchObject({ storeId: STORE, messageId: MESSAGE })
    })

    it('takes them out of the bucket when the file was removed while they were made', async () => {
      const { pipeline, put, remove } = await build({ settled: 0, rowGone: true })

      await expect(pipeline.processImage('media-1')).resolves.toBeUndefined()

      const written = put.mock.calls.map(([key]) => key as string).sort()
      expect(written).toHaveLength(3)
      expect(remove.mock.calls.map(([key]) => key as string).sort()).toEqual(written)
      expect(publish).not.toHaveBeenCalled()
    })

    it('leaves them alone and says nothing when a second attempt had already settled the row', async () => {
      const { pipeline, remove } = await build({ settled: 0, rowGone: false })

      await expect(pipeline.processImage('media-1')).resolves.toBeUndefined()

      // The keys are the same ones the other attempt wrote: deleting them would break its row
      expect(remove).not.toHaveBeenCalled()
      expect(publish).not.toHaveBeenCalled()
    })

    it('lets a failure of the bucket through, so that the queue tries again', async () => {
      const failure = new Error('the bucket is down')
      const { pipeline, update } = await build({ settled: 1, rowGone: false, putFails: failure })

      await expect(pipeline.processImage('media-1')).rejects.toBe(failure)

      // Not the image's fault: the row is not settled as refused
      expect(update).not.toHaveBeenCalled()
      expect(publish).not.toHaveBeenCalled()
    })
  })
})
