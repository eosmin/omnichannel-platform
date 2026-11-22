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
      put: jest.fn(),
      delete: jest.fn()
    }
    const logger = { setContext: jest.fn(), warn: jest.fn(), error: jest.fn() }
    const pipeline = new MediaPipeline(
      prisma as unknown as PrismaService,
      storage as unknown as StorageService,
      { scan } as unknown as ClamavClient,
      { publish: jest.fn() } as unknown as DomainEvents,
      { add: jest.fn() } as unknown as Queue<ProcessImageJob>,
      logger as unknown as PinoLogger,
      { forStore: (_id: string, work: () => Promise<unknown>) => work() } as never
    )
    return { pipeline, storage, updateMany, logger }
  }

  const evidence = [MediaPurpose.FINANCE_DOCUMENT, MediaPurpose.FISCAL_EVIDENCE]

  it.each(evidence)('keeps the file of %s when the scan gives up', async purpose => {
    const { pipeline, storage, updateMany, logger } = build(
      purpose,
      jest.fn().mockRejectedValue(new Error('the daemon is down'))
    )
    await expect(pipeline.scan('media-1', { storeId: 'store-1' }, true)).rejects.toThrow(
      'the daemon is down'
    )
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
    await pipeline.scan('media-1', { storeId: 'store-1' })
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
    await pipeline.scan('media-1', { storeId: 'store-1' })
    expect(JSON.stringify(updateMany.mock.calls)).toContain('unscannable')
    expect(storage.delete.mock.calls.length > 0).toBe(deleted)
  })

  it('still deletes an infected file that is not evidence', async () => {
    const { pipeline, storage } = build(
      MediaPurpose.MESSAGE,
      jest.fn().mockResolvedValue({ infected: true, viruses: ['x'] })
    )
    await pipeline.scan('media-1', { storeId: 'store-1' })
    expect(storage.delete).toHaveBeenCalledWith('stores/s/finance/k.pdf')
  })

  it('still gives up a file that is not evidence', async () => {
    const { pipeline, storage, updateMany } = build(
      MediaPurpose.MESSAGE,
      jest.fn().mockRejectedValue(new Error('down'))
    )
    await expect(pipeline.scan('media-1', { storeId: 'store-1' }, true)).rejects.toThrow('down')
    expect(updateMany).toHaveBeenCalled()
    expect(storage.delete).toHaveBeenCalled()
  })

  // TAX-436: a PDF kept as the receipt of a transaction that runs code when it is opened is refused, and kept as a quarantine
  describe('a PDF with active content', () => {
    const ACTIVE = Buffer.from(
      '%PDF-1.4\n1 0 obj << /Type /Catalog /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >> endobj\n%%EOF\n',
      'latin1'
    )
    const PLAIN = Buffer.from(
      '%PDF-1.4\n1 0 obj << /Type /Catalog /OpenAction [3 0 R /Fit] >> endobj\n%%EOF\n',
      'latin1'
    )

    it('refuses a finance document and keeps its file unserved', async () => {
      const { pipeline, storage, updateMany, logger } = build(
        MediaPurpose.FINANCE_DOCUMENT,
        jest.fn().mockResolvedValue({ infected: false })
      )
      storage.read.mockResolvedValue(ACTIVE)
      await pipeline.scan('media-1', { storeId: 'store-1' })
      expect(updateMany).toHaveBeenCalledTimes(1)
      expect(updateMany.mock.calls[0]?.[0]).toMatchObject({
        data: { status: 'unscannable', scanResult: { reason: 'pdf_active_content' } }
      })
      expect(JSON.stringify(updateMany.mock.calls)).toContain('JavaScript')
      expect(storage.delete).not.toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalled()
    })

    it('lets a plain PDF of a finance document become clean (a destination is not an action)', async () => {
      const { pipeline, storage, updateMany } = build(
        MediaPurpose.FINANCE_DOCUMENT,
        jest.fn().mockResolvedValue({ infected: false })
      )
      storage.read.mockResolvedValue(PLAIN)
      await pipeline.scan('media-1', { storeId: 'store-1' })
      expect(updateMany.mock.calls[0]?.[0]).toMatchObject({ data: { status: 'clean' } })
    })

    it('does not look into the active names of a PDF of a conversation (it is only cleaned of its properties)', async () => {
      const { pipeline, storage, updateMany } = build(
        MediaPurpose.MESSAGE,
        jest.fn().mockResolvedValue({ infected: false })
      )
      storage.read.mockResolvedValue(ACTIVE)
      await pipeline.scan('media-1', { storeId: 'store-1' })
      // Read once, for the cleaning of its properties; the bytes cannot be rewritten (not a real PDF), so they are kept as they came
      expect(storage.read).toHaveBeenCalledTimes(1)
      expect(storage.put).not.toHaveBeenCalled()
      expect(updateMany.mock.calls[0]?.[0]).toMatchObject({ data: { status: 'clean' } })
    })

    it('does not mark the file clean when the bucket has no bytes to look into: it is retried', async () => {
      const { pipeline, storage, updateMany } = build(
        MediaPurpose.FINANCE_DOCUMENT,
        jest.fn().mockResolvedValue({ infected: false })
      )
      storage.read.mockResolvedValue(null)
      await expect(pipeline.scan('media-1', { storeId: 'store-1' })).rejects.toThrow()
      expect(updateMany).not.toHaveBeenCalled()
    })
  })
})
