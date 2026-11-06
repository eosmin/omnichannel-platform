import { Readable } from 'node:stream'

import { UnsafeMediaLinkError, PluginError } from '@platform/plugins/sdk'

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
  const marker = {
    mark: jest.fn().mockResolvedValue(undefined),
    clear: jest.fn().mockResolvedValue(undefined)
  }
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

// The first bytes of a real file: the type is checked against them
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5])
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])

describe('InboundMediaFetcher', () => {
  const mediaId = inboundMediaId(MESSAGE, 1)

  it('stores the file under a clean name, records it pending and queues the scan', async () => {
    const plugin = { fetchMedia: jest.fn().mockResolvedValue(file(JPEG)) }
    const { fetcher, media, storage, queue, marker } = setup({ plugin })

    await fetcher.fetch(job, false)

    expect(marker.clear).toHaveBeenCalledWith(STORE, MESSAGE, 1)
    const key = `stores/${STORE}/messages/${mediaId}/__.._etc_pas_swd.jpg`
    expect(storage.put).toHaveBeenCalledWith(key, JPEG, 'image/jpeg')
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

  it('clears the lost entry of the place once the file is stored, also on a re-run', async () => {
    const plugin = { fetchMedia: jest.fn() }
    const rerun = setup({ existing: { status: 'clean' }, plugin })
    await rerun.fetcher.fetch(job, false)
    expect(rerun.marker.clear).toHaveBeenCalledWith(STORE, MESSAGE, 1)
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
    ['an empty file', file(Buffer.alloc(0))],
    ['a page declared as a picture', file(Buffer.from('<html><script>alert(1)</script>'))],
    ['a picture of another type', file(PNG_HEAD)]
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
      fetchMedia: jest.fn().mockResolvedValue(file(JPEG, 'application/octet-stream'))
    }
    const { fetcher, storage } = setup({ plugin })

    await fetcher.fetch(job, false)

    expect(storage.put).toHaveBeenCalledWith(expect.any(String), expect.any(Buffer), 'image/jpeg')
  })

  it.each(['binary/octet-stream', 'application/x-download'])(
    'takes the declared type when the file server says %s',
    async generic => {
      const plugin = { fetchMedia: jest.fn().mockResolvedValue(file(JPEG, generic)) }
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

  it('marks the file unsafe_link when the plugin will not follow a link that is not its provider’s (MS-04)', async () => {
    const plugin = { fetchMedia: jest.fn().mockRejectedValue(new UnsafeMediaLinkError()) }
    const { fetcher, marker } = setup({ plugin })

    await fetcher.fetch({ ...job, mediaRef: 'https://example.com/a.jpg' }, false)

    expect(marker.mark).toHaveBeenCalledWith(STORE, MESSAGE, 1, 'unsafe_link')
    // The same answer on every try: no retry, no offer to fetch it again
    expect(marker.mark).toHaveBeenCalledTimes(1)
  })

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
    expect(last.marker.mark).toHaveBeenCalledWith(STORE, MESSAGE, 1, 'fetch_failed', {
      pluginId: 'whatsapp',
      connectionId: '15550001111',
      ref: 'wa-media-id',
      contentType: 'image/jpeg',
      filename: '../../etc/pas swd.jpg'
    })
  })

  it('does not retry a refusal of the plugin', async () => {
    const plugin = {
      fetchMedia: jest.fn().mockRejectedValue(new PluginError('CHANNEL_MESSAGE_FAILED'))
    }
    const { fetcher, marker } = setup({ plugin })
    await expect(fetcher.fetch(job, false)).resolves.toBeUndefined()
    // A refusal the provider repeats is not offered again: no source
    expect(marker.mark).toHaveBeenCalledWith(STORE, MESSAGE, 1, 'fetch_failed', undefined)
  })

  it('records a channel that cannot fetch files', async () => {
    const { fetcher, marker } = setup({ plugin: {} })
    await fetcher.fetch(job, false)
    expect(marker.mark).toHaveBeenCalledWith(STORE, MESSAGE, 1, 'channel_cannot_fetch')
  })

  it('records the loss when keeping the bytes fails on the last attempt, and only then', async () => {
    const plugin = {
      fetchMedia: jest.fn().mockImplementation(() => Promise.resolve(file(JPEG)))
    }
    const early = setup({ plugin })
    early.storage.put.mockRejectedValue(new Error('storage down'))
    await expect(early.fetcher.fetch(job, false)).rejects.toThrow('storage down')
    expect(early.marker.mark).not.toHaveBeenCalled()

    const last = setup({ plugin })
    last.storage.put.mockRejectedValue(new Error('storage down'))
    await expect(last.fetcher.fetch(job, true)).rejects.toThrow('storage down')
    expect(last.marker.mark).toHaveBeenCalledWith(STORE, MESSAGE, 1, 'fetch_failed', {
      pluginId: 'whatsapp',
      connectionId: '15550001111',
      ref: 'wa-media-id',
      contentType: 'image/jpeg',
      filename: '../../etc/pas swd.jpg'
    })
  })

  it('keeps no source for a file named by a link: a link expires and is a credential', async () => {
    const plugin = {
      fetchMedia: jest.fn().mockRejectedValue(new PluginError('CHANNEL_MESSAGE_FAILED'))
    }
    const { fetcher, marker } = setup({ plugin })

    // On the last attempt the loss is recorded, whatever the address resolves to here
    await fetcher
      .fetch({ ...job, mediaRef: 'https://cdn.example.com/a.jpg?sig=secret' }, true)
      .catch(() => undefined)

    expect(marker.mark).toHaveBeenCalledWith(STORE, MESSAGE, 1, 'fetch_failed', undefined)
  })

  it('cuts a long type and name so that the stored source still reads back', async () => {
    const plugin = {
      fetchMedia: jest
        .fn()
        .mockRejectedValue(new PluginError('CHANNEL_MESSAGE_FAILED', { retryable: true }))
    }
    const { fetcher, marker } = setup({ plugin })

    await fetcher
      .fetch({ ...job, contentType: 'x'.repeat(400), filename: 'n'.repeat(400) }, true)
      .catch(() => undefined)

    const source = (marker.mark.mock.calls[0] as unknown[] | undefined)?.[4] as {
      contentType: string
      filename: string
    }
    expect(source.contentType).toHaveLength(255)
    expect(source.filename).toHaveLength(255)
  })

  it('keeps a null name as null in the source', async () => {
    const plugin = {
      fetchMedia: jest
        .fn()
        .mockRejectedValue(new PluginError('CHANNEL_MESSAGE_FAILED', { retryable: true }))
    }
    const { fetcher, marker } = setup({ plugin })

    await fetcher.fetch({ ...job, filename: null }, true).catch(() => undefined)

    expect(marker.mark).toHaveBeenCalledWith(
      STORE,
      MESSAGE,
      1,
      'fetch_failed',
      expect.objectContaining({ filename: null })
    )
  })

  describe('an id chosen by the plugin', () => {
    const CHOSEN = '33333333-3333-4333-8333-333333333333'
    const chosen = { ...job, pluginId: 'web_widget', mediaId: CHOSEN }
    const plugin = () => ({
      fetchMedia: jest.fn().mockResolvedValue(file(JPEG))
    })
    const collision = Object.assign(new Error('unique'), { code: 'P2002' })

    it('gives the stored file that id and queues the scan for it', async () => {
      const { fetcher, media, storage, queue } = setup({
        plugin: plugin(),
        connection: { pluginId: 'web_widget' }
      })

      await fetcher.fetch(chosen, false)

      expect(media.create).toHaveBeenCalledWith({
        data: {
          id: CHOSEN,
          purpose: 'message',
          contentType: 'image/jpeg',
          storeId: STORE,
          messageId: MESSAGE,
          customerId: 'c1',
          uploadedBy: null,
          key: `stores/${STORE}/messages/${CHOSEN}/__.._etc_pas_swd.jpg`,
          filename: '__.._etc_pas_swd.jpg',
          status: 'pending',
          fileSize: 9
        }
      })
      expect(storage.put).toHaveBeenCalledTimes(1)
      expect(queue.add).toHaveBeenCalledWith(
        'scan-file',
        { mediaId: CHOSEN },
        { jobId: `scan-file-${CHOSEN}` }
      )
    })

    it.each([
      ['a plugin that is not the web widget', { ...chosen, pluginId: 'whatsapp' }],
      ['an id that is not a uuid', { ...chosen, mediaId: '../../other' }]
    ])('derives the id from message and place for %s', async (_name, data) => {
      const { fetcher, storage } = setup({
        plugin: plugin(),
        connection: { pluginId: 'web_widget' }
      })

      await fetcher.fetch(data, false)

      expect(storage.put).toHaveBeenCalledWith(
        expect.stringContaining(`/messages/${mediaId}/`),
        expect.anything(),
        'image/jpeg'
      )
    })

    it('looks for an earlier attempt under that id, of this message', async () => {
      const { fetcher, media } = setup({ existing: { status: 'clean' }, plugin: {} })

      await fetcher.fetch(chosen, false)

      expect(media.findFirst).toHaveBeenCalledWith({
        where: { id: CHOSEN, storeId: STORE, messageId: MESSAGE },
        select: { status: true }
      })
    })

    it('refuses the file, with no retry, when the id is already a file of something else', async () => {
      const { fetcher, media, storage, queue, marker } = setup({ plugin: plugin() })
      media.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: CHOSEN })

      await expect(fetcher.fetch(chosen, false)).resolves.toBeUndefined()

      expect(marker.mark).toHaveBeenCalledWith(STORE, MESSAGE, 1, 'refused')
      expect(storage.put).not.toHaveBeenCalled()
      expect(media.create).not.toHaveBeenCalled()
      expect(queue.add).not.toHaveBeenCalled()
    })

    it('refuses it too when the row only shows at the insert, and accepts a row of this message', async () => {
      const refused = setup({ plugin: plugin() })
      refused.media.create.mockRejectedValueOnce(collision)
      refused.media.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
      await expect(refused.fetcher.fetch(chosen, false)).resolves.toBeUndefined()
      expect(refused.marker.mark).toHaveBeenCalledWith(STORE, MESSAGE, 1, 'refused')
      expect(refused.queue.add).not.toHaveBeenCalled()

      const same = setup({ plugin: plugin() })
      same.media.create.mockRejectedValueOnce(collision)
      same.media.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: CHOSEN })
      await expect(same.fetcher.fetch(chosen, false)).resolves.toBeUndefined()
      expect(same.marker.clear).toHaveBeenCalledWith(STORE, MESSAGE, 1)
      expect(same.storage.put).toHaveBeenCalledTimes(1)
      expect(same.queue.add).toHaveBeenCalledTimes(1)
    })
  })
})
