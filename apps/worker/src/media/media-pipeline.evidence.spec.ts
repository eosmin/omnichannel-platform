import type { Queue } from 'bullmq'
import type { PinoLogger } from 'nestjs-pino'

import type { PrismaService } from '@platform/core/database'
import type { DomainEvents } from '@platform/core/event-bus'
import type { ProcessImageJob } from '@platform/core/queues'
import { MediaPurpose } from '@platform/core/storage'
import type { StorageService } from '@platform/core/storage-module'

import type { ClamavClient } from './clamav.client'
import { MediaPipeline } from './media-pipeline.service'

// HC-122: the scan never deletes the file of a financial document (a receipt, a bank statement)
describe('MediaPipeline and financial evidence', () => {
  const row = (purpose: string, contentType: string) => ({
    id: 'media-1',
    storeId: null,
    key: 'stores/s/finance/k.pdf',
    contentType,
    purpose,
    status: 'pending',
    processedAt: null,
    scanResult: null,
    messageId: null,
    origin: null
  })

  function build(purpose: string, scan: jest.Mock, contentType = 'application/pdf') {
    const updateMany = jest
      .fn<Promise<{ count: number }>, [unknown]>()
      .mockResolvedValue({ count: 1 })
    const prisma = {
      client: {
        media: { findUnique: jest.fn().mockResolvedValue(row(purpose, contentType)), updateMany }
      },
      transaction: jest.fn()
    }
    const storage = {
      stream: jest.fn().mockResolvedValue('body'),
      read: jest.fn(),
      delete: jest.fn()
    }
    const logger = { setContext: jest.fn(), warn: jest.fn(), error: jest.fn() }
    const pipeline = new MediaPipeline(
      prisma as unknown as PrismaService,
      storage as unknown as StorageService,
      { scan } as unknown as ClamavClient,
      { publish: jest.fn() } as unknown as DomainEvents,
      { add: jest.fn() } as unknown as Queue<ProcessImageJob>,
      logger as unknown as PinoLogger
    )
    return { pipeline, storage, updateMany, logger }
  }

  const evidence = [MediaPurpose.FINANCE_DOCUMENT, MediaPurpose.FISCAL_EVIDENCE]

  it.each(evidence)('keeps the file of %s when the scan gives up', async purpose => {
    const { pipeline, storage, updateMany, logger } = build(
      purpose,
      jest.fn().mockRejectedValue(new Error('the daemon is down'))
    )
    await expect(pipeline.scan('media-1', true)).rejects.toThrow('the daemon is down')
    expect(storage.delete).not.toHaveBeenCalled()
    // The row stays pending: never served, and the cleanup queues the scan again
    expect(updateMany).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalled()
  })

  it.each(evidence)('keeps the file of %s as a quarantine when it is infected', async purpose => {
    const { pipeline, storage, updateMany, logger } = build(
      purpose,
      jest.fn().mockResolvedValue({ infected: true, viruses: ['x'] })
    )
    await pipeline.scan('media-1')
    expect(updateMany.mock.calls[0]?.[0]).toMatchObject({ data: { status: 'infected' } })
    expect(storage.delete).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalled()
  })

  it.each([
    [MediaPurpose.FINANCE_DOCUMENT, false],
    [MediaPurpose.MESSAGE, true]
  ])('a picture that cannot be decoded (%s) has its file deleted: %s', async (purpose, deleted) => {
    const { pipeline, storage, updateMany } = build(
      purpose,
      jest.fn().mockResolvedValue({ infected: false }),
      'image/png'
    )
    storage.read.mockResolvedValue(Buffer.from('this is not a picture'))
    await pipeline.scan('media-1')
    expect(JSON.stringify(updateMany.mock.calls)).toContain('unscannable')
    expect(storage.delete.mock.calls.length > 0).toBe(deleted)
  })

  it('still deletes an infected file that is not evidence', async () => {
    const { pipeline, storage } = build(
      MediaPurpose.MESSAGE,
      jest.fn().mockResolvedValue({ infected: true, viruses: ['x'] })
    )
    await pipeline.scan('media-1')
    expect(storage.delete).toHaveBeenCalledWith('stores/s/finance/k.pdf')
  })

  it('still gives up a file that is not evidence', async () => {
    const { pipeline, storage, updateMany } = build(
      MediaPurpose.MESSAGE,
      jest.fn().mockRejectedValue(new Error('down'))
    )
    await expect(pipeline.scan('media-1', true)).rejects.toThrow('down')
    expect(updateMany).toHaveBeenCalled()
    expect(storage.delete).toHaveBeenCalled()
  })
})
