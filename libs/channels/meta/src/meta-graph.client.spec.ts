import { createHmac } from 'node:crypto'
import { Readable } from 'node:stream'

import { z } from 'zod'

import { MetaGraph, MetaLimits, MetaWebhookApps } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { PluginError } from '@platform/plugins/sdk'

import { MetaGraphClient } from './meta-graph.client'

const config = { appSecret: 'secret', verifyToken: 'verify', graphVersion: 'v23.0' }
const TOKEN = 'connection-token'
const MEDIA_URL = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1'
const CDN_URL = 'https://scontent.whatsapp.net/v/file.jpg'

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  })

async function read(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks)
}

describe('MetaGraphClient', () => {
  let fetchMock: jest.SpyInstance<Promise<Response>, Parameters<typeof fetch>>
  let client: MetaGraphClient

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch')
    client = new MetaGraphClient(config)
  })
  afterEach(() => jest.restoreAllMocks())

  describe('webhook checks', () => {
    it('validates the signature header with the app secret', () => {
      const body = '{"a":1}'
      const signature = `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`
      expect(
        client.isValidSignature(body, { 'x-hub-signature-256': signature }, MetaWebhookApps.MAIN)
      ).toBe(true)
      expect(client.isValidSignature(body, {}, MetaWebhookApps.MAIN)).toBe(false)
    })

    describe('the signature by app', () => {
      const body = '{"a":1}'
      const signed = (secret: string): Record<string, string> => ({
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
      })
      const both = (): MetaGraphClient =>
        new MetaGraphClient({ ...config, instagramAppSecret: 'instagram-secret' })

      it('checks Instagram with its own secret alone when it has one: the main one no longer passes', () => {
        const two = both()
        expect(
          two.isValidSignature(body, signed('instagram-secret'), MetaWebhookApps.INSTAGRAM)
        ).toBe(true)
        expect(two.isValidSignature(body, signed('secret'), MetaWebhookApps.INSTAGRAM)).toBe(false)
      })

      it('keeps the main secret for the other channels, and refuses the Instagram one there', () => {
        const two = both()
        expect(two.isValidSignature(body, signed('secret'), MetaWebhookApps.MAIN)).toBe(true)
        expect(two.isValidSignature(body, signed('instagram-secret'), MetaWebhookApps.MAIN)).toBe(
          false
        )
      })

      it('checks Instagram with the main secret when it has none of its own', () => {
        expect(client.isValidSignature(body, signed('secret'), MetaWebhookApps.INSTAGRAM)).toBe(
          true
        )
        expect(
          client.isValidSignature(body, signed('instagram-secret'), MetaWebhookApps.INSTAGRAM)
        ).toBe(false)
      })

      it('checks Instagram with its own secret when the main one is missing', () => {
        const only = new MetaGraphClient({
          ...config,
          appSecret: undefined,
          instagramAppSecret: 'instagram-secret'
        })
        expect(
          only.isValidSignature(body, signed('instagram-secret'), MetaWebhookApps.INSTAGRAM)
        ).toBe(true)
        expect(only.isValidSignature(body, signed('secret'), MetaWebhookApps.MAIN)).toBe(false)
      })

      it('does not fall back to the main secret when the Instagram one is empty: it refuses everything', () => {
        const empty = new MetaGraphClient({ ...config, instagramAppSecret: '' })
        expect(empty.isValidSignature(body, signed('secret'), MetaWebhookApps.INSTAGRAM)).toBe(
          false
        )
        expect(empty.isValidSignature(body, signed(''), MetaWebhookApps.INSTAGRAM)).toBe(false)
      })

      it('refuses an Instagram signature when neither secret is set', () => {
        const none = new MetaGraphClient({ ...config, appSecret: undefined })
        expect(none.isValidSignature(body, signed(''), MetaWebhookApps.INSTAGRAM)).toBe(false)
        expect(none.isValidSignature(body, {}, MetaWebhookApps.INSTAGRAM)).toBe(false)
      })
    })

    it('answers the handshake with the verify token', () => {
      const query = { 'hub.mode': 'subscribe', 'hub.verify_token': 'verify', 'hub.challenge': '42' }
      expect(client.verifyHubChallenge(query)).toBe('42')
      expect(client.verifyHubChallenge({ ...query, 'hub.verify_token': 'x' })).toBeNull()
    })
  })

  describe('get and post', () => {
    const schema = z.object({ id: z.string() })

    it('calls the versioned url with the token in the header, not in the url', async () => {
      fetchMock.mockResolvedValue(json({ id: '1' }))

      await expect(
        client.get({
          path: ['123', 'message_templates'],
          token: TOKEN,
          schema,
          query: { limit: '5' }
        })
      ).resolves.toEqual({ id: '1' })

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://graph.facebook.com/v23.0/123/message_templates?limit=5')
      expect(url).not.toContain(TOKEN)
      expect(init.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` })
      expect(init.redirect).toBe('manual')
      expect(init.signal).toBeInstanceOf(AbortSignal)
    })

    it('calls the host of the config in place of Facebook', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(json({ id: '1' })))
      const fake = new MetaGraphClient({ ...config, graphOrigin: 'http://localhost:8099' })

      await fake.get({ path: ['123'], token: TOKEN, schema })

      expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['http://localhost:8099/v23.0/123'])
    })

    it('posts the body as json', async () => {
      fetchMock.mockResolvedValue(json({ id: '2' }))

      await client.post({ path: ['123', 'messages'], token: TOKEN, schema, body: { to: '5731' } })

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(init.method).toBe('POST')
      expect(init.body).toBe('{"to":"5731"}')
      expect(init.headers).toMatchObject({ 'content-type': 'application/json' })
    })

    it.each([['..'], ['a/b'], ['a?b'], ['a#b'], ['a b'], ['']])(
      'refuses the path segment %j before calling anything',
      async segment => {
        await expect(
          client.get({ path: ['123', segment], token: TOKEN, schema })
        ).rejects.toBeInstanceOf(PluginError)
        expect(fetchMock).not.toHaveBeenCalled()
      }
    )

    it.each(['bad\ntoken', 'tok\u00e9n', ''])(
      'says the credentials are invalid for a token that cannot be a header (%j), not a retryable failure',
      async token => {
        await expect(client.get({ path: ['1'], token, schema })).rejects.toMatchObject({
          code: ErrorCodes.CHANNEL_CREDENTIALS_INVALID,
          retryable: false
        })
        expect(fetchMock).not.toHaveBeenCalled()
      }
    )

    describe('failures', () => {
      const request = { path: ['1', 'messages'], token: TOKEN, schema, body: { a: 1 } }

      it('asks to try again after a timeout of a read', async () => {
        fetchMock.mockRejectedValue(new DOMException('timed out', 'TimeoutError'))

        await expect(client.get({ path: ['1'], token: TOKEN, schema })).rejects.toMatchObject({
          retryable: true
        })
      })

      it('does not try a send again after a timeout or a network failure: it may have gone out', async () => {
        fetchMock.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
        await expect(client.post(request)).rejects.toMatchObject({ retryable: false })

        fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
        await expect(client.post(request)).rejects.toMatchObject({ retryable: false })
      })

      it('does not try a send again after a 500, and does after a 429', async () => {
        fetchMock.mockResolvedValueOnce(json({ error: { code: 1 } }, 500))
        await expect(client.post(request)).rejects.toMatchObject({ retryable: false })

        fetchMock.mockResolvedValueOnce(json({ error: { code: 4 } }, 429))
        await expect(client.post(request)).rejects.toMatchObject({ retryable: true })
      })

      it('does try a post again that says it is safe to repeat', async () => {
        fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
        await expect(client.post({ ...request, idempotent: true })).rejects.toMatchObject({
          retryable: true
        })

        fetchMock.mockResolvedValueOnce(json({ error: { code: 1 } }, 500))
        await expect(client.post({ ...request, idempotent: true })).rejects.toMatchObject({
          retryable: true
        })
      })

      it('asks to try a read again, and not a send, when a 200 has no json in it', async () => {
        fetchMock.mockResolvedValue(new Response('<html>', { status: 200 }))

        await expect(client.get({ path: ['1'], token: TOKEN, schema })).rejects.toMatchObject({
          retryable: true
        })
        await expect(client.post(request)).rejects.toMatchObject({ retryable: false })
      })

      it.each([301, 302, 307])(
        'does not follow a redirect (HTTP %i) from Graph and does not try again',
        async status => {
          fetchMock.mockResolvedValue(
            new Response(null, { status, headers: { location: 'https://evil.example.com/' } })
          )

          await expect(client.get({ path: ['1'], token: TOKEN, schema })).rejects.toMatchObject({
            retryable: false
          })
          expect(fetchMock).toHaveBeenCalledTimes(1)
        }
      )
    })

    it('refuses an empty path', async () => {
      await expect(client.get({ path: [], token: TOKEN, schema })).rejects.toBeInstanceOf(
        PluginError
      )
    })

    it('refuses an answer that is not the shape its caller expects', async () => {
      fetchMock.mockResolvedValue(json({ id: 7 }))

      await expect(client.get({ path: ['1'], token: TOKEN, schema })).rejects.toMatchObject({
        code: ErrorCodes.CHANNEL_MESSAGE_FAILED,
        retryable: false
      })
    })

    it('turns a rejected token into credentials invalid', async () => {
      fetchMock.mockResolvedValue(json({ error: { code: 190, message: TOKEN } }, 401))

      const error = await client.get({ path: ['1'], token: TOKEN, schema }).catch((e: unknown) => e)

      expect(error).toMatchObject({
        code: ErrorCodes.CHANNEL_CREDENTIALS_INVALID,
        retryable: false
      })
      expect(JSON.stringify(error)).not.toContain(TOKEN)
    })

    it('asks to try again after a throttle and after an answer that is not json', async () => {
      fetchMock.mockResolvedValueOnce(json({ error: { code: 80008 } }, 400))
      await expect(client.get({ path: ['1'], token: TOKEN, schema })).rejects.toMatchObject({
        retryable: true
      })

      fetchMock.mockResolvedValueOnce(new Response('<html>bad gateway</html>', { status: 502 }))
      await expect(client.get({ path: ['1'], token: TOKEN, schema })).rejects.toMatchObject({
        retryable: true
      })
    })

    it('asks to try again when the network fails or the call times out', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'))

      await expect(client.get({ path: ['1'], token: TOKEN, schema })).rejects.toMatchObject({
        code: ErrorCodes.CHANNEL_MESSAGE_FAILED,
        retryable: true
      })
    })
  })

  describe('graph host', () => {
    it("calls Facebook's host when the request names none", async () => {
      fetchMock.mockResolvedValue(json({ id: '1' }))

      await client.get({ path: ['me'], token: TOKEN, schema: z.object({ id: z.string() }) })

      expect(fetchMock.mock.calls[0]?.[0]).toBe('https://graph.facebook.com/v23.0/me')
    })
  })

  describe('downloadMediaUrl', () => {
    const CDN = 'https://scontent-iad3-1.xx.fbcdn.net/v/t1/file.jpg?sig=1'

    it('streams a CDN file with no token and reads the type the server declares', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response('abc', {
          headers: { 'content-type': 'Image/JPEG; charset=binary', 'content-length': '3' }
        })
      )

      const media = await client.downloadMediaUrl(CDN)

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe(CDN)
      expect(init.headers).not.toHaveProperty('authorization')
      expect(media.contentType).toBe('image/jpeg')
      expect((await read(media.stream)).toString()).toBe('abc')
    })

    it('accepts the Instagram CDN', async () => {
      fetchMock.mockResolvedValueOnce(new Response('x'))
      await expect(
        client.downloadMediaUrl('https://scontent.cdninstagram.com/v/file.jpg')
      ).resolves.toBeDefined()
    })

    it('accepts the Messenger file host and no other host of fbsbx', async () => {
      fetchMock.mockResolvedValueOnce(new Response('x'))
      await expect(
        client.downloadMediaUrl('https://cdn.fbsbx.com/v/t59.3654-21/clip.mp4')
      ).resolves.toBeDefined()
      await expect(
        client.downloadMediaUrl('https://apps.fbsbx.com/instagram_graph_api/x')
      ).rejects.toBeInstanceOf(PluginError)
    })

    it('uses plain bytes when the server declares no usable type', async () => {
      fetchMock.mockResolvedValueOnce(new Response('x', { headers: { 'content-type': 'nope' } }))
      expect((await client.downloadMediaUrl(CDN)).contentType).toBe(MetaGraph.FALLBACK_CONTENT_TYPE)
    })

    it.each([
      ['plain http', 'http://scontent.fbcdn.net/x'],
      ['a host that is not Meta', 'https://evil.example.com/x'],
      ['a look-alike host', 'https://fbcdn.net.evil.example.com/x'],
      ['an internal address', 'https://169.254.169.254/latest'],
      ['text that is not a url', 'not a url']
    ])('refuses %s without calling it', async (_name, url) => {
      await expect(client.downloadMediaUrl(url)).rejects.toBeInstanceOf(PluginError)
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  describe('downloadMedia', () => {
    const info = (overrides: Record<string, unknown> = {}): Response =>
      json({ url: MEDIA_URL, mime_type: 'image/jpeg', ...overrides })

    it('asks for the url, then streams the file with the same token', async () => {
      fetchMock.mockResolvedValueOnce(info()).mockResolvedValueOnce(
        new Response('hello', {
          headers: { 'content-type': 'image/jpeg; charset=x', 'content-length': '5' }
        })
      )

      const media = await client.downloadMedia(TOKEN, '999')

      expect(fetchMock.mock.calls[0]?.[0]).toBe('https://graph.facebook.com/v23.0/999')
      const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit]
      expect(url).toBe(MEDIA_URL)
      expect(init.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` })
      expect(init.redirect).toBe('manual')
      expect(media.contentType).toBe('image/jpeg')
      expect(media.contentLength).toBe(5)
      expect((await read(media.stream)).toString()).toBe('hello')
    })

    it('falls back to the type Meta declared when the file has none', async () => {
      fetchMock
        .mockResolvedValueOnce(info())
        .mockResolvedValueOnce(new Response(new Uint8Array([120])))

      const media = await client.downloadMedia(TOKEN, '999')

      expect(media.contentType).toBe('image/jpeg')
      expect(media.contentLength).toBeNull()
    })

    it.each([
      ['plain http', 'http://lookaside.fbsbx.com/x'],
      ['a host that is not Meta', 'https://evil.example.com/x'],
      ['a look-alike host', 'https://fbsbx.com.evil.example.com/x'],
      ['an internal address', 'https://169.254.169.254/latest'],
      ['a port', 'https://lookaside.fbsbx.com:8443/x'],
      ['credentials in the url', 'https://user:pw@lookaside.fbsbx.com/x'],
      ['a password alone in the url', 'https://:pw@lookaside.fbsbx.com/x'],
      ['a facebook.com host, which serves user content', 'https://www.facebook.com/x'],
      ['another fbsbx.com host, the sandbox of third-party content', 'https://apps.fbsbx.com/x']
    ])('never follows %s', async (_name, url) => {
      fetchMock.mockResolvedValueOnce(info({ url }))

      await expect(client.downloadMedia(TOKEN, '999')).rejects.toBeInstanceOf(PluginError)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('refuses a file that says it is bigger than the limit before downloading it', async () => {
      fetchMock.mockResolvedValueOnce(info({ file_size: MetaLimits.MEDIA_MAX_BYTES + 1 }))

      await expect(client.downloadMedia(TOKEN, '999')).rejects.toBeInstanceOf(PluginError)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('refuses a file whose content-length is over the limit', async () => {
      fetchMock.mockResolvedValueOnce(info()).mockResolvedValueOnce(
        new Response('x', {
          headers: { 'content-length': String(MetaLimits.MEDIA_MAX_BYTES + 1) }
        })
      )

      await expect(client.downloadMedia(TOKEN, '999')).rejects.toBeInstanceOf(PluginError)
    })

    it('sends the token only to the host that needs it, not to a CDN', async () => {
      fetchMock
        .mockResolvedValueOnce(info({ url: CDN_URL }))
        .mockResolvedValueOnce(new Response(new Uint8Array([1])))

      await client.downloadMedia(TOKEN, '999')

      const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit]
      expect(url).toBe(CDN_URL)
      expect(JSON.stringify(init.headers ?? {})).not.toContain(TOKEN)
    })

    it.each([301, 302, 307])(
      'does not follow a redirect (HTTP %i) and does not try again',
      async status => {
        fetchMock
          .mockResolvedValueOnce(info())
          .mockResolvedValueOnce(
            new Response(null, { status, headers: { location: 'https://evil.example.com/' } })
          )

        await expect(client.downloadMedia(TOKEN, '999')).rejects.toMatchObject({
          code: ErrorCodes.CHANNEL_MESSAGE_FAILED,
          retryable: false
        })
        expect(fetchMock).toHaveBeenCalledTimes(2)
      }
    )

    it('cancels the body underneath when the consumer gives up on the stream', async () => {
      let cancelled = false
      const body = new ReadableStream<Uint8Array>({
        pull(controller): void {
          controller.enqueue(new Uint8Array(1024))
        },
        cancel: () => {
          cancelled = true
        }
      })
      fetchMock
        .mockResolvedValueOnce(info({ file_size: 1 }))
        .mockResolvedValueOnce(new Response(body))

      const media = await client.downloadMedia(TOKEN, '999')
      media.stream.on('error', () => undefined)
      ;(media.stream as Readable).destroy()
      await new Promise(resolve => setImmediate(resolve))

      expect(cancelled).toBe(true)
    })

    it('takes a declared size of exactly the limit and refuses one byte over', async () => {
      fetchMock
        .mockResolvedValueOnce(info({ file_size: MetaLimits.MEDIA_MAX_BYTES }))
        .mockResolvedValueOnce(new Response(new Uint8Array([1])))
      const media = await client.downloadMedia(TOKEN, '999')
      ;(media.stream as Readable).destroy()

      fetchMock.mockResolvedValueOnce(info({ file_size: MetaLimits.MEDIA_MAX_BYTES + 1 }))
      await expect(client.downloadMedia(TOKEN, '999')).rejects.toBeInstanceOf(PluginError)
    })

    it('reports the content-length of exactly the limit it was given', async () => {
      fetchMock.mockResolvedValueOnce(info()).mockResolvedValueOnce(
        new Response(new Uint8Array([1]), {
          headers: { 'content-length': String(MetaLimits.MEDIA_MAX_BYTES) }
        })
      )
      // The body is one byte, shorter than it announced: the stream will fail, and nobody reads it here
      const media = await client.downloadMedia(TOKEN, '999')
      media.stream.on('error', () => undefined)
      expect(media.contentLength).toBe(MetaLimits.MEDIA_MAX_BYTES)
    })

    it.each(['', ' ', '0x10', '1e3', '-1', '12abc'])(
      'ignores a content-length that is not a byte count (%j), not reading it as a number',
      async header => {
        fetchMock
          .mockResolvedValueOnce(info({ file_size: undefined }))
          .mockResolvedValueOnce(
            new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-length': header } })
          )

        const media = await client.downloadMedia(TOKEN, '999')

        expect(media.contentLength).toBeNull()
        expect((await read(media.stream)).length).toBe(3)
      }
    )

    it('fails a download that ends short of its content-length, and asks to try again', async () => {
      fetchMock
        .mockResolvedValueOnce(info())
        .mockResolvedValueOnce(
          new Response(new Uint8Array([1, 2]), { headers: { 'content-length': '5' } })
        )

      const media = await client.downloadMedia(TOKEN, '999')

      await expect(read(media.stream)).rejects.toMatchObject({ retryable: true })
    })

    it('asks for the file uncompressed, so that its content-length is its real length', async () => {
      fetchMock
        .mockResolvedValueOnce(info())
        .mockResolvedValueOnce(new Response(new Uint8Array([1])))
      fetchMock
        .mockResolvedValueOnce(info({ url: CDN_URL }))
        .mockResolvedValueOnce(new Response(new Uint8Array([1])))

      await client.downloadMedia(TOKEN, '999')
      await client.downloadMedia(TOKEN, '999')

      for (const call of [1, 3]) {
        const [, init] = fetchMock.mock.calls[call] as [string, RequestInit]
        expect(init.headers).toMatchObject({ 'accept-encoding': 'identity' })
      }
    })

    it('refuses an answer with no body', async () => {
      fetchMock
        .mockResolvedValueOnce(info())
        .mockResolvedValueOnce(new Response(null, { status: 200 }))

      await expect(client.downloadMedia(TOKEN, '999')).rejects.toMatchObject({ retryable: false })
    })

    it('asks to try again when Meta fails while giving the url', async () => {
      fetchMock.mockResolvedValueOnce(json({ error: { code: 2 } }, 503))

      await expect(client.downloadMedia(TOKEN, '999')).rejects.toMatchObject({ retryable: true })
    })

    it.each(['me', 'debug_token', '12/34', '12a'])(
      'only asks for a numeric media id, not %j, so the token cannot read other nodes',
      async mediaId => {
        await expect(client.downloadMedia(TOKEN, mediaId)).rejects.toBeInstanceOf(PluginError)
        expect(fetchMock).not.toHaveBeenCalled()
      }
    )

    it('trusts the type Meta declared, not the one the file server sends', async () => {
      fetchMock
        .mockResolvedValueOnce(info())
        .mockResolvedValueOnce(new Response('x', { headers: { 'content-type': 'text/html' } }))

      expect((await client.downloadMedia(TOKEN, '999')).contentType).toBe('image/jpeg')
    })

    it('does not report the compressed length as the length of the stream', async () => {
      fetchMock
        .mockResolvedValueOnce(info())
        .mockResolvedValueOnce(
          new Response('x', { headers: { 'content-length': '1', 'content-encoding': 'gzip' } })
        )

      expect((await client.downloadMedia(TOKEN, '999')).contentLength).toBeNull()
    })

    it('closes the body of an answer it refuses', async () => {
      let cancelled = false
      const body = new ReadableStream<Uint8Array>({
        cancel: () => {
          cancelled = true
        }
      })
      fetchMock
        .mockResolvedValueOnce(info())
        .mockResolvedValueOnce(new Response(body, { status: 404 }))

      await expect(client.downloadMedia(TOKEN, '999')).rejects.toBeInstanceOf(PluginError)
      expect(cancelled).toBe(true)
    })

    it('gives a stream that breaks halfway as a plugin error, not as the raw one', async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.error(new DOMException('aborted', 'AbortError'))
        }
      })
      fetchMock.mockResolvedValueOnce(info()).mockResolvedValueOnce(new Response(body))

      const media = await client.downloadMedia(TOKEN, '999')

      await expect(read(media.stream)).rejects.toMatchObject({ retryable: true })
    })

    it.each([401, 403, 404, 410])(
      'asks to try again after HTTP %i on the file: the url expires, the token is not the problem',
      async status => {
        fetchMock.mockResolvedValueOnce(info()).mockResolvedValueOnce(new Response('', { status }))

        await expect(client.downloadMedia(TOKEN, '999')).rejects.toMatchObject({
          code: ErrorCodes.CHANNEL_MESSAGE_FAILED,
          retryable: true
        })
      }
    )

    it('reports a download that fails like any other failed call', async () => {
      fetchMock
        .mockResolvedValueOnce(info())
        .mockResolvedValueOnce(new Response('', { status: 400 }))

      await expect(client.downloadMedia(TOKEN, '999')).rejects.toMatchObject({
        code: ErrorCodes.CHANNEL_MESSAGE_FAILED,
        retryable: false
      })
    })

    it('asks to try again when the file server is down', async () => {
      fetchMock
        .mockResolvedValueOnce(info())
        .mockResolvedValueOnce(new Response('', { status: 503 }))

      await expect(client.downloadMedia(TOKEN, '999')).rejects.toMatchObject({ retryable: true })
    })
  })

  describe('uploadMedia', () => {
    const schema = z.object({ id: z.string() })
    const opened: Readable[] = []
    const fileOf = (bytes: string, size = Buffer.byteLength(bytes)) => ({
      open: () => {
        const stream = Readable.from([Buffer.from(bytes)])
        opened.push(stream)
        return Promise.resolve(stream)
      },
      contentType: 'image/png',
      size
    })
    const upload = (file = fileOf('abc')) =>
      client.uploadMedia({
        path: ['111', 'media'],
        token: TOKEN,
        fields: { messaging_product: 'whatsapp', type: 'image/png' },
        file,
        schema
      })

    // fetch reads the body while the mock answers, as the real one does
    function answerAfterReading(response: Response): void {
      fetchMock.mockImplementation(async (_url, init) => {
        const body = init?.body as ReadableStream<Uint8Array>
        const reader = body.getReader()
        const chunks: Buffer[] = []
        for (;;) {
          const part = await reader.read()
          if (part.done) break
          chunks.push(Buffer.from(part.value))
        }
        captured = { init: init ?? {}, body: Buffer.concat(chunks).toString('latin1') }
        return response
      })
    }
    let captured: { init: RequestInit; body: string } | undefined

    beforeEach(() => {
      captured = undefined
      opened.length = 0
    })

    it('posts a multipart body with the fields, then the file and its type, and answers the id', async () => {
      answerAfterReading(json({ id: '555' }))

      await expect(upload()).resolves.toEqual({ id: '555' })

      const headers = captured?.init.headers as Record<string, string>
      const boundary = /boundary=(.+)$/.exec(headers['content-type'] ?? '')?.[1]
      expect(boundary).toBeDefined()
      expect(captured?.body).toBe(
        [
          `--${boundary}`,
          'Content-Disposition: form-data; name="messaging_product"',
          '',
          'whatsapp',
          `--${boundary}`,
          'Content-Disposition: form-data; name="type"',
          '',
          'image/png',
          `--${boundary}`,
          'Content-Disposition: form-data; name="file"; filename="upload"',
          'Content-Type: image/png',
          '',
          'abc',
          `--${boundary}--`,
          ''
        ].join('\r\n')
      )
      // The length is exact, so the body is not sent chunked and Graph can check it
      expect(headers['content-length']).toBe(String(Buffer.byteLength(captured?.body ?? '')))
      expect(headers['authorization']).toBe(`Bearer ${TOKEN}`)
      expect(fetchMock.mock.calls[0]?.[0]).toBe('https://graph.facebook.com/v23.0/111/media')
      expect(captured?.init.signal).toBeDefined()
    })

    it.each([
      ['a type with a line break', 'image/png\r\nX-Evil: 1'],
      ['a type that is not a type', 'image'],
      ['an empty type', '']
    ])('refuses %s before calling Meta', async (_label, contentType) => {
      const file = { ...fileOf('abc'), contentType }

      await expect(upload(file)).rejects.toBeInstanceOf(PluginError)

      expect(fetchMock).not.toHaveBeenCalled()
      // Nothing was opened to be left hanging
      expect(opened).toHaveLength(0)
    })

    it.each([
      ['a field name with a quote', { 'a"b': 'x' }],
      ['a field value with a line break', { type: 'x\r\ny' }]
    ])('refuses %s before calling Meta', async (_label, fields) => {
      await expect(
        client.uploadMedia({
          path: ['111', 'media'],
          token: TOKEN,
          fields,
          file: fileOf('abc'),
          schema
        })
      ).rejects.toBeInstanceOf(PluginError)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('fails for good, not to be tried again, when the stream holds more bytes than the size recorded', async () => {
      answerAfterReading(json({ id: '1' }))
      await expect(upload(fileOf('abcdef', 3))).rejects.toMatchObject({ retryable: false })
    })

    it('closes the stored file when Meta answers before reading all of it', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(json({ error: { code: 100 } }, 400)))

      await expect(upload()).rejects.toBeInstanceOf(PluginError)

      expect(opened).toHaveLength(1)
      expect(opened[0]?.destroyed).toBe(true)
    })

    it('fails when the stream ends before the announced size', async () => {
      answerAfterReading(json({ id: '1' }))
      await expect(upload(fileOf('ab', 3))).rejects.toBeInstanceOf(PluginError)
    })

    it('says invalid credentials for a token Meta refuses, with its code for the logs and no text', async () => {
      answerAfterReading(
        json({ error: { message: `bad ${TOKEN}`, code: 190, error_subcode: 463 } }, 401)
      )

      const error = await upload().catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(PluginError)
      expect(error).toMatchObject({
        code: ErrorCodes.CHANNEL_CREDENTIALS_INVALID,
        providerCode: 190,
        providerSubcode: 463
      })
      expect(JSON.stringify(error)).not.toContain(TOKEN)
    })

    it('can be tried again after a server error: nothing was sent to the customer', async () => {
      answerAfterReading(json({ error: { code: 2 } }, 500))
      await expect(upload()).rejects.toMatchObject({ retryable: true })
    })

    it('does not follow a redirect and refuses an answer that is not an id', async () => {
      answerAfterReading(
        new Response(null, { status: 302, headers: { location: 'https://evil.test' } })
      )
      await expect(upload()).rejects.toBeInstanceOf(PluginError)
      expect(fetchMock).toHaveBeenCalledTimes(1)

      fetchMock.mockReset()
      answerAfterReading(json({ nope: true }))
      await expect(upload()).rejects.toBeInstanceOf(PluginError)
    })

    it('refuses a token that cannot be a header, without calling Meta', async () => {
      await expect(
        client.uploadMedia({
          path: ['111', 'media'],
          token: 'bad\ntoken',
          fields: {},
          file: fileOf('abc'),
          schema
        })
      ).rejects.toMatchObject({ code: ErrorCodes.CHANNEL_CREDENTIALS_INVALID })
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})
