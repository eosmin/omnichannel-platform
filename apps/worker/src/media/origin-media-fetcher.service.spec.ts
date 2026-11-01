import { Readable } from 'node:stream'

// The barrel of connections loads the environment of the app, which a unit run does not have
jest.mock('@platform/channels/connections', () => ({
  withTimeout: <T>(work: Promise<T>) => work
}))
const pinnedHttpsGet = jest.fn<Promise<unknown>, unknown[]>()
jest.mock('./pinned-https-get', () => ({
  ...jest.requireActual<object>('./pinned-https-get'),
  pinnedHttpsGet: (...args: unknown[]): Promise<unknown> => pinnedHttpsGet(...args)
}))

import { MediaStatus, OriginMediaSlots } from '@platform/core/domain'
import { JobNames } from '@platform/core/queues'
import { MediaPurpose } from '@platform/core/storage'

import { originMediaId } from './inbound-media-id'
import { OriginMediaFetcher } from './origin-media-fetcher.service'
import { PinnedFetchFailed } from './pinned-https-get'
import { UnsafeUrlError } from './public-url'

const STORE = '11111111-1111-4111-8111-111111111111'
const ORIGIN = '33333333-3333-4333-8333-333333333333'
const THUMB = { storeId: STORE, originId: ORIGIN, slot: OriginMediaSlots.THUMBNAIL }
const MEDIA = { storeId: STORE, originId: ORIGIN, slot: OriginMediaSlots.MEDIA }

function setup(options: { existing?: { status: string } | null; origin?: object | null }) {
  const media = {
    findFirst: jest.fn().mockResolvedValue(options.existing ?? null),
    create: jest.fn().mockResolvedValue({})
  }
  const origin = {
    findFirst: jest.fn().mockResolvedValue(
      options.origin === undefined
        ? {
            mediaType: 'image',
            mediaUrl: 'https://cdn.example.com/full/ad.jpg?sig=1',
            thumbnailUrl: 'https://cdn.example.com/thumb/ad-thumb.png'
          }
        : options.origin
    )
  }
  const storage = {
    put: jest.fn<Promise<void>, [string, Buffer, string]>().mockResolvedValue(undefined)
  }
  const queue = { add: jest.fn().mockResolvedValue(undefined) }
  const logger = { setContext: jest.fn(), warn: jest.fn() }
  const fetcher = new OriginMediaFetcher(
    { client: { media, conversationOrigin: origin } } as never,
    storage as never,
    queue as never,
    logger as never
  )
  return { fetcher, media, storage, queue, logger }
}

const answer = (body: Buffer, contentType = 'image/png', contentLength: number | null = null) => ({
  stream: Readable.from([body]),
  contentType,
  contentLength: contentLength ?? body.length
})

describe('OriginMediaFetcher', () => {
  beforeEach(() => pinnedHttpsGet.mockReset())

  it('keeps the thumbnail as a pending file of the origin, with no message and no customer', async () => {
    pinnedHttpsGet.mockResolvedValue(answer(Buffer.from('pngbytes')))
    const { fetcher, media, storage, queue } = setup({})
    const id = originMediaId(ORIGIN, OriginMediaSlots.THUMBNAIL)

    await fetcher.fetch(THUMB)

    expect(pinnedHttpsGet.mock.calls[0]?.[0]).toBe('https://cdn.example.com/thumb/ad-thumb.png')
    const key = `stores/${STORE}/messages/${id}/ad-thumb.png`
    expect(storage.put).toHaveBeenCalledWith(key, Buffer.from('pngbytes'), 'image/png')
    expect(media.create).toHaveBeenCalledWith({
      data: {
        id,
        storeId: STORE,
        purpose: MediaPurpose.ORIGIN,
        originId: ORIGIN,
        originSlot: OriginMediaSlots.THUMBNAIL,
        uploadedBy: null,
        key,
        filename: 'ad-thumb.png',
        contentType: 'image/png',
        fileSize: 8,
        status: MediaStatus.PENDING
      }
    })
    expect(queue.add).toHaveBeenCalledWith(
      JobNames.SCAN_FILE,
      { mediaId: id },
      { jobId: `${JobNames.SCAN_FILE}-${id}` }
    )
  })

  it('keeps the media of an ad only when it is an image', async () => {
    const { fetcher, storage } = setup({
      origin: { mediaType: 'video', mediaUrl: 'https://cdn.example.com/v.mp4', thumbnailUrl: null }
    })
    await fetcher.fetch(MEDIA)
    expect(pinnedHttpsGet).not.toHaveBeenCalled()
    expect(storage.put).not.toHaveBeenCalled()
  })

  it('only queues the scan when an earlier attempt stored the file', async () => {
    const { fetcher, storage, queue } = setup({ existing: { status: MediaStatus.PENDING } })
    await fetcher.fetch(THUMB)
    expect(pinnedHttpsGet).not.toHaveBeenCalled()
    expect(storage.put).not.toHaveBeenCalled()
    expect(queue.add).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the origin is gone', async () => {
    const { fetcher, storage } = setup({ origin: null })
    await fetcher.fetch(THUMB)
    expect(pinnedHttpsGet).not.toHaveBeenCalled()
    expect(storage.put).not.toHaveBeenCalled()
  })

  it.each([
    ['not an image', answer(Buffer.from('<html>'), 'text/html')],
    ['a type the server did not declare', answer(Buffer.from('x'), 'application/octet-stream')],
    ['too big by its header', answer(Buffer.from('x'), 'image/png', 11 * 1024 * 1024)],
    ['empty', answer(Buffer.alloc(0))]
  ])('drops a file that is %s, for good', async (_name, response) => {
    pinnedHttpsGet.mockResolvedValue(response)
    const { fetcher, storage, media, logger } = setup({})
    await expect(fetcher.fetch(THUMB)).resolves.toBeUndefined()
    expect(storage.put).not.toHaveBeenCalled()
    expect(media.create).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalled()
  })

  it('drops a link that is not safe, and one the server says is gone', async () => {
    const { fetcher, storage } = setup({})
    pinnedHttpsGet.mockRejectedValueOnce(new UnsafeUrlError('not https'))
    await expect(fetcher.fetch(THUMB)).resolves.toBeUndefined()
    pinnedHttpsGet.mockRejectedValueOnce(new PinnedFetchFailed('status 404', false))
    await expect(fetcher.fetch(THUMB)).resolves.toBeUndefined()
    expect(storage.put).not.toHaveBeenCalled()
  })

  it('throws a failure that may pass, so that the job is tried again', async () => {
    pinnedHttpsGet.mockRejectedValue(new PinnedFetchFailed('status 503', true))
    const { fetcher } = setup({})
    await expect(fetcher.fetch(THUMB)).rejects.toBeInstanceOf(PinnedFetchFailed)
  })

  it('keeps a file the server served as a generic download when its bytes are an image', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    pinnedHttpsGet.mockResolvedValue(answer(png, 'application/octet-stream'))
    const { fetcher, media } = setup({})
    await fetcher.fetch(THUMB)
    expect(media.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        contentType: 'image/png',
        purpose: MediaPurpose.ORIGIN
      }) as object
    })
  })

  it('does not fetch the media when its link is the one of the thumbnail', async () => {
    const { fetcher, storage } = setup({
      origin: {
        mediaType: 'image',
        mediaUrl: 'https://cdn.example.com/same.jpg',
        thumbnailUrl: 'https://cdn.example.com/same.jpg'
      }
    })
    await fetcher.fetch(MEDIA)
    expect(pinnedHttpsGet).not.toHaveBeenCalled()
    expect(storage.put).not.toHaveBeenCalled()
  })

  it('names the file by its slot when the link has no name', async () => {
    pinnedHttpsGet.mockResolvedValue(answer(Buffer.from('png')))
    const { fetcher, storage } = setup({
      origin: { mediaType: null, mediaUrl: null, thumbnailUrl: 'https://cdn.example.com/' }
    })
    await fetcher.fetch(THUMB)
    expect(storage.put.mock.calls[0]?.[0]).toMatch(/\/thumbnail\.png$/)
  })
})
