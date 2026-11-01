import { Readable } from 'node:stream'

import { PluginError } from '@platform/plugins/sdk'

// The barrel of connections loads the environment of the app, which a unit run does not have
jest.mock('@platform/channels/connections', () => ({
  CONNECTION_ROW_SELECT: {},
  ChannelContextFactory: class {},
  errorName: (error: unknown) => (error instanceof Error ? error.name : 'unknown'),
  withTimeout: <T>(work: Promise<T>) => work
}))

import { InboundMediaFetcher } from './inbound-media-fetcher.service'
import { inboundMediaId } from './inbound-media-id'

const STORE = '11111111-1111-4111-8111-111111111111'
const MESSAGE = '22222222-2222-4222-8222-222222222222'
const job = {
  messageId: MESSAGE,
  index: 1,
  storeId: STORE,
  pluginId: 'whatsapp',
  connectionId: '15550001111',
  mediaRef: 'wa-media-id',
  contentType: 'image/jpeg',
  filename: '../../etc/pas swd.jpg'
}

function setup(options: {
  existing?: { status: string } | null
  message?: object | null
  connection?: object | null
  plugin?: object | undefined
}) {
  const media = {
    findFirst: jest.fn().mockResolvedValue(options.existing ?? null),
    create: jest.fn().mockResolvedValue({})
  }
  const prisma = {
    client: {
      media,
      message: {
        findFirst: jest
          .fn()
          .mockResolvedValue(
            options.message === undefined ? { conversation: { customerId: 'c1' } } : options.message
          )
      },
      channelConnection: {
        findFirst: jest
          .fn()
          .mockResolvedValue(
            options.connection === undefined ? { pluginId: 'whatsapp' } : options.connection
          )
      }
    }
  }
  const storage = { put: jest.fn().mockResolvedValue(undefined) }
  const registry = { find: jest.fn().mockReturnValue(options.plugin) }
  const contexts = { contextFor: jest.fn().mockReturnValue({}) }
  const queue = { add: jest.fn().mockResolvedValue(undefined) }
  const logger = { setContext: jest.fn(), warn: jest.fn() }
  const marker = { mark: jest.fn().mockResolvedValue(undefined) }
  const fetcher = new InboundMediaFetcher(
    prisma as never,
    storage as never,
    registry as never,
    contexts as never,
    queue as never,
    marker as never,
    logger as never
  )
  return { fetcher, media, storage, queue, logger, marker }
}

const file = (body: Buffer, contentType = 'image/jpeg', contentLength: number | null = null) => ({
  stream: Readable.from([body]),
  contentType,
  contentLength: contentLength ?? body.length
})

describe('InboundMediaFetcher', () => {
  const mediaId = inboundMediaId(MESSAGE, 1)

  it('stores the file under a clean name, records it pending and queues the scan', async () => {
    const plugin = { fetchMedia: jest.fn().mockResolvedValue(file(Buffer.from('jpegbytes'))) }
    const { fetcher, media, storage, queue } = setup({ plugin })

    await fetcher.fetch(job, false)

    const key = `stores/${STORE}/messages/${mediaId}/__.._etc_pas_swd.jpg`
    expect(storage.put).toHaveBeenCalledWith(key, Buffer.from('jpegbytes'), 'image/jpeg')
    expect(media.create).toHaveBeenCalledWith({
      data: {
        id: mediaId,
        purpose: 'message',
        contentType: 'image/jpeg',
        storeId: STORE,
        messageId: MESSAGE,
        customerId: 'c1',
        uploadedBy: null,
        key,
        filename: '__.._etc_pas_swd.jpg',
        status: 'pending',
        fileSize: 9
      }
    })
    expect(queue.add).toHaveBeenCalledWith(
      'scan-file',
      { mediaId },
      { jobId: `scan-file-${mediaId}` }
    )
  })

  it('only queues the scan again when an earlier attempt already stored the file', async () => {
    const plugin = { fetchMedia: jest.fn() }
    const { fetcher, storage, queue } = setup({ existing: { status: 'pending' }, plugin })

    await fetcher.fetch(job, false)

    expect(plugin.fetchMedia).not.toHaveBeenCalled()
    expect(storage.put).not.toHaveBeenCalled()
    expect(queue.add).toHaveBeenCalledTimes(1)
  })

  it('does nothing for a media that is past pending', async () => {
    const { fetcher, queue } = setup({ existing: { status: 'clean' }, plugin: {} })
    await fetcher.fetch(job, false)
    expect(queue.add).not.toHaveBeenCalled()
  })

  it('does nothing when the message or the connection is gone', async () => {
    const plugin = { fetchMedia: jest.fn() }
    await setup({ message: null, plugin }).fetcher.fetch(job, false)
    await setup({ connection: null, plugin }).fetcher.fetch(job, false)
    expect(plugin.fetchMedia).not.toHaveBeenCalled()
  })

  it.each([
    ['a type that is not allowed', file(Buffer.from('x'), 'text/html')],
    ['a declared size over the limit', file(Buffer.from('x'), 'image/jpeg', 11 * 1024 * 1024)],
    ['an empty file', file(Buffer.alloc(0))]
  ])('keeps no file for %s', async (_label, fetched) => {
    const plugin = { fetchMedia: jest.fn().mockResolvedValue(fetched) }
    const { fetcher, storage, media, logger, marker } = setup({ plugin })

    await expect(fetcher.fetch(job, false)).resolves.toBeUndefined()
    expect(marker.mark).toHaveBeenCalledWith(STORE, MESSAGE, 1, 'refused')

    expect(storage.put).not.toHaveBeenCalled()
    expect(media.create).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalled()
  })

  it('cuts a body that grows past the limit', async () => {
    const big = Readable.from([Buffer.alloc(6 * 1024 * 1024), Buffer.alloc(6 * 1024 * 1024)])
    const plugin = {
      fetchMedia: jest
        .fn()
        .mockResolvedValue({ stream: big, contentType: 'image/jpeg', contentLength: null })
    }
    const { fetcher, storage } = setup({ plugin })

    await fetcher.fetch(job, false)

    expect(storage.put).not.toHaveBeenCalled()
  })

  it('takes the declared type when the file server says it is generic', async () => {
    const plugin = {
      fetchMedia: jest.fn().mockResolvedValue(file(Buffer.from('x'), 'application/octet-stream'))
    }
    const { fetcher, storage } = setup({ plugin })

    await fetcher.fetch(job, false)

    expect(storage.put).toHaveBeenCalledWith(expect.any(String), expect.any(Buffer), 'image/jpeg')
  })

  it.each(['binary/octet-stream', 'application/x-download'])(
    'takes the declared type when the file server says %s',
    async generic => {
      const plugin = { fetchMedia: jest.fn().mockResolvedValue(file(Buffer.from('x'), generic)) }
      const { fetcher, storage } = setup({ plugin })

      await fetcher.fetch(job, false)

      expect(storage.put).toHaveBeenCalledWith(expect.any(String), expect.any(Buffer), 'image/jpeg')
    }
  )

  it.each([' https://169.254.169.254/a', '//127.0.0.1/a', 'file:///etc/passwd', 'a b'])(
    'treats %j as a link and refuses it',
    async mediaRef => {
      const plugin = { fetchMedia: jest.fn() }
      const { fetcher, marker } = setup({ plugin })
      await fetcher.fetch({ ...job, mediaRef }, false)
      expect(plugin.fetchMedia).not.toHaveBeenCalled()
      expect(marker.mark).toHaveBeenCalledWith(STORE, MESSAGE, 1, 'unsafe_link')
    }
  )

  it('refuses a link to a private address before the plugin is asked', async () => {
    const plugin = { fetchMedia: jest.fn() }
    const { fetcher, storage } = setup({ plugin })

    await fetcher.fetch({ ...job, mediaRef: 'https://169.254.169.254/latest' }, false)
    await fetcher.fetch({ ...job, mediaRef: 'http://cdn.example.com/a.jpg' }, false)

    expect(plugin.fetchMedia).not.toHaveBeenCalled()
    expect(storage.put).not.toHaveBeenCalled()
  })

  it('fails the job for a failure the plugin calls retryable, on every attempt', async () => {
    const error = new PluginError('CHANNEL_MESSAGE_FAILED', { retryable: true })
    const plugin = { fetchMedia: jest.fn().mockRejectedValue(error) }

    const early = setup({ plugin })
    await expect(early.fetcher.fetch(job, false)).rejects.toThrow(/fetching a customer file failed/)
    // Still being retried: the file is not given up on yet
    expect(early.marker.mark).not.toHaveBeenCalled()
    // Also on the last attempt, so that the loss reaches the dead-letter queue; the thread says so too
    const last = setup({ plugin })
    await expect(last.fetcher.fetch(job, true)).rejects.toThrow(/fetching a customer file failed/)
    expect(last.marker.mark).toHaveBeenCalledWith(STORE, MESSAGE, 1, 'fetch_failed')
  })

  it('does not retry a refusal of the plugin', async () => {
    const plugin = {
      fetchMedia: jest.fn().mockRejectedValue(new PluginError('CHANNEL_MESSAGE_FAILED'))
    }
    const { fetcher, marker } = setup({ plugin })
    await expect(fetcher.fetch(job, false)).resolves.toBeUndefined()
    expect(marker.mark).toHaveBeenCalledWith(STORE, MESSAGE, 1, 'fetch_failed')
  })

  it('records a channel that cannot fetch files', async () => {
    const { fetcher, marker } = setup({ plugin: {} })
    await fetcher.fetch(job, false)
    expect(marker.mark).toHaveBeenCalledWith(STORE, MESSAGE, 1, 'channel_cannot_fetch')
  })

  it('records the loss when keeping the bytes fails on the last attempt, and only then', async () => {
    const plugin = {
      fetchMedia: jest.fn().mockImplementation(() => Promise.resolve(file(Buffer.from('x'))))
    }
    const early = setup({ plugin })
    early.storage.put.mockRejectedValue(new Error('storage down'))
    await expect(early.fetcher.fetch(job, false)).rejects.toThrow('storage down')
    expect(early.marker.mark).not.toHaveBeenCalled()

    const last = setup({ plugin })
    last.storage.put.mockRejectedValue(new Error('storage down'))
    await expect(last.fetcher.fetch(job, true)).rejects.toThrow('storage down')
    expect(last.marker.mark).toHaveBeenCalledWith(STORE, MESSAGE, 1, 'fetch_failed')
  })
})
