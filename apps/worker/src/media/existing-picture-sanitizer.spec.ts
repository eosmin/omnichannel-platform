import type { PinoLogger } from 'nestjs-pino'
import sharp from 'sharp'

import type { JobContext, PrismaService } from '@platform/core/database'
import { carriesMetadata, ImageNotSanitizable, sanitizeImage } from '@platform/core/image-sanitizer'
import { ExistingPictureSweep } from '@platform/core/storage'
import type { StorageService } from '@platform/core/storage-module'

import { ExistingPictureSanitizer } from './existing-picture-sanitizer.service'

jest.mock('@platform/core/image-sanitizer', () => ({
  ...jest.requireActual<object>('@platform/core/image-sanitizer'),
  carriesMetadata: jest.fn(),
  sanitizeImage: jest.fn()
}))

const STORE = 'store-1'
const asMock = jest.mocked(carriesMetadata)
const cleaning = jest.mocked(sanitizeImage)
const actualSanitize = jest.requireActual<{ sanitizeImage: typeof sanitizeImage }>(
  '@platform/core/image-sanitizer'
).sanitizeImage

// The decisions of the sweep that need a failure to be seen (the real bucket and database are in the integration spec)
describe('ExistingPictureSanitizer, on what goes wrong', () => {
  const updates: { where: unknown; data: { scanResult: unknown } }[] = []
  const put = jest.fn()
  const head = jest.fn()
  const read = jest.fn()
  const findMany = jest.fn()
  const updateMany = jest.fn()
  const sanitizer = new ExistingPictureSanitizer(
    {
      client: { media: { findMany, updateMany }, store: { findMany: jest.fn() } }
    } as unknown as PrismaService,
    { forStore: (_id: string, work: () => Promise<unknown>) => work() } as unknown as JobContext,
    { head, read, put } as unknown as StorageService,
    {
      setContext: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      info: jest.fn()
    } as unknown as PinoLogger
  )

  beforeEach(() => {
    jest.resetAllMocks()
    updates.length = 0
    updateMany.mockImplementation((call: { where: unknown; data: { scanResult: unknown } }) => {
      updates.push(call)
      return Promise.resolve({ count: 1 })
    })
    head.mockResolvedValue({ etag: 'e1', contentLength: 10, contentType: 'image/jpeg' })
  })

  const row = (scanResult: unknown = null) => ({
    id: 'm1',
    key: 'k1',
    contentType: 'image/jpeg',
    scanResult
  })
  const photo = (): Promise<Buffer> =>
    sharp({ create: { width: 8, height: 8, channels: 3, background: '#336699' } })
      .withMetadata({ exif: { IFD0: { Make: 'Acme' } } })
      .jpeg()
      .toBuffer()

  it('does not mark as undecodable a picture whose header failed for lack of memory: it counts a failed attempt', async () => {
    findMany.mockResolvedValue([row()])
    read.mockResolvedValue(await photo())
    asMock.mockRejectedValue(new Error('Cannot allocate memory'))

    const report = await sanitizer.runScoped([STORE])

    expect(report).toMatchObject({ failed: 1, skipped: 0 })
    expect(updates).toHaveLength(1)
    expect(updates[0]?.data.scanResult).toEqual({ [ExistingPictureSweep.ATTEMPTS_KEY]: 1 })
    expect(put).not.toHaveBeenCalled()
  })

  it('gives a row up as failed after the last attempt, so that it cannot hold the batch of its store', async () => {
    findMany.mockResolvedValue([
      row({ [ExistingPictureSweep.ATTEMPTS_KEY]: ExistingPictureSweep.MAX_ATTEMPTS - 1 })
    ])
    read.mockResolvedValue(await photo())
    asMock.mockRejectedValue(new Error('Cannot allocate memory'))

    await sanitizer.runScoped([STORE])

    expect(updates[0]?.data.scanResult).toEqual({
      [ExistingPictureSweep.ATTEMPTS_KEY]: ExistingPictureSweep.MAX_ATTEMPTS,
      [ExistingPictureSweep.OUTCOME_KEY]: ExistingPictureSweep.Outcomes.FAILED
    })
  })

  it('does not use the budget of the run for failures', async () => {
    findMany.mockResolvedValue(Array.from({ length: 3 }, () => row()))
    read.mockResolvedValue(await photo())
    asMock.mockRejectedValue(new Error('Cannot allocate memory'))

    const report = await sanitizer.runScoped([STORE, 'store-2'])

    expect(report.failed).toBe(6) // Both stores were taken: a failing store did not end the run
    expect(findMany).toHaveBeenCalledTimes(2)
  })

  it('leaves the picture alone, unmarked, when the object changed between the read and the write', async () => {
    findMany.mockResolvedValue([row()])
    read.mockResolvedValue(await photo())
    asMock.mockResolvedValue(true)
    cleaning.mockImplementation(actualSanitize)
    head
      .mockResolvedValueOnce({ etag: 'e1', contentLength: 10, contentType: 'image/jpeg' })
      .mockResolvedValueOnce({ etag: 'e2', contentLength: 10, contentType: 'image/jpeg' })

    const report = await sanitizer.runScoped([STORE])

    expect(report).toMatchObject({ skipped: 1, cleaned: 0 })
    expect(put).not.toHaveBeenCalled()
    expect(updates).toHaveLength(0)
  })

  it('does not count as cleaned a picture whose row went while its file was written', async () => {
    findMany.mockResolvedValue([row()])
    read.mockResolvedValue(await photo())
    asMock.mockResolvedValue(true)
    cleaning.mockImplementation(actualSanitize)
    updateMany.mockResolvedValue({ count: 0 })

    const report = await sanitizer.runScoped([STORE])

    expect(put).toHaveBeenCalledTimes(1)
    expect(report).toMatchObject({ cleaned: 0, skipped: 1 })
  })

  it('records a picture that cannot be brought under the file limit as not cleanable, not as undecodable', async () => {
    findMany.mockResolvedValue([row()])
    read.mockResolvedValue(await photo())
    asMock.mockResolvedValue(true)
    cleaning.mockRejectedValue(
      new ImageNotSanitizable('the cleaned picture does not fit the file limit')
    )

    const report = await sanitizer.runScoped([STORE])

    expect(report.skipped).toBe(1)
    expect(updates[0]?.data.scanResult).toEqual({
      [ExistingPictureSweep.OUTCOME_KEY]: ExistingPictureSweep.Outcomes.NOT_CLEANABLE
    })
    expect(put).not.toHaveBeenCalled()
  })
})
