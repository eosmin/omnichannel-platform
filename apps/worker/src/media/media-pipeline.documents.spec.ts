import type { Queue } from 'bullmq'
import type { PinoLogger } from 'nestjs-pino'
import { PDFDocument } from 'pdf-lib'

import type { PrismaService } from '@platform/core/database'
import { sanitizeDocument } from '@platform/core/document-sanitizer'
import type { DomainEvents } from '@platform/core/event-bus'
import type { ProcessImageJob } from '@platform/core/queues'
import { MediaPurpose } from '@platform/core/storage'
import type { StorageService } from '@platform/core/storage-module'

import type { ClamavClient } from './clamav.client'
import { MediaPipeline } from './media-pipeline.service'

const AUTHOR = 'Jane Q. Author'

// Step 7.1: a PDF that is not financial evidence loses its properties on the scan; evidence is kept as it came
describe('MediaPipeline and the properties of a document', () => {
  async function pdf(): Promise<Buffer> {
    const doc = await PDFDocument.create()
    doc.addPage([100, 100])
    doc.setAuthor(AUTHOR)
    return Buffer.from(await doc.save({ useObjectStreams: false }))
  }

  function build(purpose: string, scanResult: unknown = null) {
    const updateMany = jest
      .fn<Promise<{ count: number }>, [unknown]>()
      .mockResolvedValue({ count: 1 })
    const prisma = {
      client: {
        media: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'media-1',
            storeId: null,
            key: 'stores/s/doc.pdf',
            contentType: 'application/pdf',
            purpose,
            status: 'pending',
            processedAt: null,
            scanResult,
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
      read: jest.fn(),
      put: jest.fn<Promise<void>, [string, Buffer, string]>().mockResolvedValue(undefined),
      delete: jest.fn()
    }
    const logger = { setContext: jest.fn(), warn: jest.fn(), error: jest.fn() }
    const pipeline = new MediaPipeline(
      prisma as unknown as PrismaService,
      storage as unknown as StorageService,
      { scan: jest.fn().mockResolvedValue({ infected: false }) } as unknown as ClamavClient,
      { publish: jest.fn() } as unknown as DomainEvents,
      { add: jest.fn() } as unknown as Queue<ProcessImageJob>,
      logger as unknown as PinoLogger,
      { forStore: (_id: string, work: () => Promise<unknown>) => work() } as never
    )
    return { pipeline, storage, updateMany, logger }
  }

  it('writes the cleaned PDF of a conversation and marks the row, then marks it clean', async () => {
    const { pipeline, storage, updateMany } = build(MediaPurpose.MESSAGE)
    const dirty = await pdf()
    storage.read.mockResolvedValue(dirty)

    await pipeline.scan('media-1', { storeId: 'store-1' })

    expect(storage.put).toHaveBeenCalledTimes(1)
    const [key, body] = storage.put.mock.calls[0] ?? []
    expect(key).toBe('stores/s/doc.pdf')
    expect(body?.includes(AUTHOR)).toBe(false)
    const calls = JSON.stringify(updateMany.mock.calls)
    expect(calls).toContain('"sanitized":true')
    expect(updateMany.mock.calls.at(-1)?.[0]).toMatchObject({ data: { status: 'clean' } })
  })

  it.each([MediaPurpose.FINANCE_DOCUMENT, MediaPurpose.FISCAL_EVIDENCE])(
    'keeps the PDF of %s exactly as it came',
    async purpose => {
      const { pipeline, storage } = build(purpose)
      storage.read.mockResolvedValue(await pdf())

      await pipeline.scan('media-1', { storeId: 'store-1' })

      expect(storage.put).not.toHaveBeenCalled()
    }
  )

  it('does not rewrite a document a first attempt already cleaned', async () => {
    const { pipeline, storage } = build(MediaPurpose.MESSAGE, { sanitized: true })
    storage.read.mockResolvedValue(await pdf())

    await pipeline.scan('media-1', { storeId: 'store-1' })

    expect(storage.put).not.toHaveBeenCalled()
  })

  it('makes the row true when a retry finds the object already cleaned (the update failed after the write)', async () => {
    const { pipeline, storage, updateMany } = build(MediaPurpose.MESSAGE)
    const first = await sanitizeDocument(await pdf(), 'application/pdf')
    if (first.kind !== 'sanitized') throw new Error('expected a cleaned pdf')
    storage.read.mockResolvedValue(first.body)

    await pipeline.scan('media-1', { storeId: 'store-1' })

    expect(storage.put).not.toHaveBeenCalled()
    expect(updateMany.mock.calls[0]?.[0]).toMatchObject({
      data: { fileSize: first.body.length, scanResult: { sanitized: true } }
    })
  })

  it('stops when the row moved on while the document was cleaned', async () => {
    const { pipeline, storage, updateMany } = build(MediaPurpose.MESSAGE)
    storage.read.mockResolvedValue(await pdf())
    updateMany.mockResolvedValue({ count: 0 })

    await pipeline.scan('media-1', { storeId: 'store-1' })

    // Only the update of the cleaning was tried: the row is not marked clean over a row that was replaced
    expect(updateMany).toHaveBeenCalledTimes(1)
  })

  it('keeps the original and retries when the bucket refuses the write', async () => {
    const { pipeline, storage, updateMany } = build(MediaPurpose.MESSAGE)
    storage.read.mockResolvedValue(await pdf())
    storage.put.mockRejectedValue(new Error('bucket down'))

    await expect(pipeline.scan('media-1', { storeId: 'store-1' })).rejects.toThrow('bucket down')

    expect(storage.delete).not.toHaveBeenCalled()
    expect(JSON.stringify(updateMany.mock.calls)).not.toContain('clean')
  })

  it('keeps a PDF it cannot rewrite, logs it without the name of the file, and serves it', async () => {
    const { pipeline, storage, updateMany, logger } = build(MediaPurpose.MESSAGE)
    storage.read.mockResolvedValue(Buffer.from('%PDF-1.4 broken'))

    await pipeline.scan('media-1', { storeId: 'store-1' })

    expect(storage.put).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      { mediaId: 'media-1', storeId: null },
      expect.stringContaining('kept as it came')
    )
    expect(updateMany.mock.calls.at(-1)?.[0]).toMatchObject({ data: { status: 'clean' } })
  })
})
