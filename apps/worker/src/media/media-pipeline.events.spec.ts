import type { Queue } from 'bullmq'
import type { PinoLogger } from 'nestjs-pino'

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
  const media = (messageId: string | null) => ({
    id: 'media-1',
    storeId: STORE,
    messageId,
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

  it('announces nothing for a file that belongs to no message', async () => {
    await build(media(null), false).scan('media-1')
    expect(publish).not.toHaveBeenCalled()
  })
})
