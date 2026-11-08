import {
  ChannelIds,
  DeliveryStatus,
  MessageType,
  WIDGET_TOKEN_HEADER,
  WidgetMetadataKeys
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { StorageKeys } from '@platform/core/storage'
import type { StorageService } from '@platform/core/storage-module'
import {
  ChannelCapability,
  type ChannelContext,
  ChannelEventTypes,
  PluginError
} from '@platform/plugins/sdk'

import { WebWidgetPlugin } from './web-widget.plugin'
import { isSiteKey } from './widget-site'
import { signVisitorToken, widgetTokenKey } from './widget-token'

// These channels send by link: the file is never opened
const sendsByLink = (): Promise<NodeJS.ReadableStream> =>
  Promise.reject(new Error('this channel sends by link'))

const tokenKey = widgetTokenKey('s'.repeat(32))
const storage = {
  list: jest.fn(),
  head: jest.fn(),
  stream: jest.fn()
}
const plugin = new WebWidgetPlugin({ tokenKey }, storage as unknown as StorageService)
const visitorId = '3f2c1a9e-4b7d-4c1e-9a55-0d1e2f3a4b5c'
const siteKey = 'pk_widget_AAAAAAAAAAAAAAAAAAAAAAAA'
const ctx: ChannelContext = { storeId: 's', connectionId: siteKey, credentials: {}, metadata: {} }
const token = signVisitorToken(tokenKey, { siteKey, visitorId })

describe('WebWidgetPlugin', () => {
  it('asks for the sites, as a list, and has no provider to point at a callback url', () => {
    expect(plugin.connectFields).toEqual([
      expect.objectContaining({ key: 'siteOrigins', secret: false, required: true, multiple: true })
    ])
    expect(plugin.receivesProviderWebhooks).toBe(false)
  })

  it('declares text, images, documents, typing and read receipts, with no window', () => {
    expect(plugin.id).toBe(ChannelIds.WEB_WIDGET)
    expect(plugin.capabilities).toEqual([
      ChannelCapability.TEXT,
      ChannelCapability.IMAGE,
      ChannelCapability.DOCUMENT,
      ChannelCapability.TYPING_INDICATOR,
      ChannelCapability.CUSTOMER_TYPING,
      ChannelCapability.READ_RECEIPTS
    ])
    expect(plugin.messagingWindow).toBeNull()
  })

  it('has nothing to send for a typing indicator: the api shows it through the socket of the visitor', async () => {
    await expect(plugin.sendTypingIndicator()).resolves.toBeUndefined()
  })

  describe('connect', () => {
    it('makes a site key and keeps the origins of the sites', async () => {
      const result = await plugin.connect({
        storeId: 's',
        credentials: { siteOrigins: ['https://Shop.test', 'https://shop.test/'] }
      })
      expect(isSiteKey(result.connectionId)).toBe(true)
      expect(result.displayName).toBe('shop.test')
      expect(result.credentials).toEqual({})
      expect(result.metadata).toEqual({
        [WidgetMetadataKeys.ALLOWED_ORIGINS]: ['https://shop.test']
      })
    })

    it('makes a different key each time', async () => {
      const input = { storeId: 's', credentials: { siteOrigins: ['https://shop.test'] } }
      const [a, b] = await Promise.all([plugin.connect(input), plugin.connect(input)])
      expect(a.connectionId).not.toBe(b.connectionId)
    })

    it.each([
      {},
      { siteOrigins: [] },
      { siteOrigins: ['shop.test'] },
      { siteOrigins: 'https://a.test' }
    ])('refuses %j', async credentials => {
      await expect(plugin.connect({ storeId: 's', credentials })).rejects.toMatchObject({
        code: ErrorCodes.CHANNEL_CREDENTIALS_INVALID
      })
    })
  })

  describe('inbound', () => {
    const body = { visitorToken: token, clientMessageId: 'abc-1', content: '  hola  ' }

    it('takes the token as the signature', () => {
      expect(plugin.validateWebhookSignature('', { [WIDGET_TOKEN_HEADER]: token })).toBe(true)
      expect(plugin.validateWebhookSignature('', { [WIDGET_TOKEN_HEADER]: 'x.y' })).toBe(false)
      expect(plugin.validateWebhookSignature('', {})).toBe(false)
    })

    it('reads a message as the visitor of the token, to the connection of the token', async () => {
      const [event, ...rest] = await plugin.handleWebhook(body)
      expect(rest).toEqual([])
      expect(event).toMatchObject({
        type: ChannelEventTypes.MESSAGE_RECEIVED,
        connectionId: siteKey,
        channelIdentity: visitorId,
        message: { externalId: `${visitorId}:abc-1`, type: MessageType.TEXT, content: 'hola' }
      })
    })

    it('carries what the visitor typed in the form as the profile of the event', async () => {
      const [event] = await plugin.handleWebhook({
        ...body,
        profile: { name: 'Ana', email: 'ana@example.com', phone: '+503 7000 1111' }
      })

      expect(event?.channelProfile).toEqual({
        displayName: 'Ana',
        email: 'ana@example.com',
        phone: '+503 7000 1111'
      })
    })

    it('sends no profile when there is none, or when it is empty', async () => {
      const [without] = await plugin.handleWebhook(body)
      const [empty] = await plugin.handleWebhook({ ...body, profile: {} })

      expect(without).not.toHaveProperty('channelProfile')
      expect(empty).not.toHaveProperty('channelProfile')
    })

    it('reads nothing from a profile with a field it does not know or one that is too long', async () => {
      await expect(
        plugin.handleWebhook({ ...body, profile: { name: 'Ana', admin: true } })
      ).resolves.toEqual([])
      await expect(
        plugin.handleWebhook({ ...body, profile: { email: 'a'.repeat(255) } })
      ).resolves.toEqual([])
    })

    const uploadId = '8b1f6a3c-52d4-4e5a-9a3b-7c1d2e3f4a5b'
    const png = { id: uploadId, filename: 'foto.png', contentType: 'image/png' }

    it('reads a message of files, typed by the first one, with the upload id as the reference', async () => {
      const pdf = {
        id: '9c2a7b4d-63e5-4f6b-8b4c-8d2e3f4a5b6c',
        filename: 'a.pdf',
        contentType: 'application/pdf'
      }
      const [event] = await plugin.handleWebhook({
        visitorToken: token,
        clientMessageId: 'abc-2',
        attachments: [png, pdf]
      })

      expect(event?.message).toMatchObject({
        type: MessageType.IMAGE,
        content: null,
        media: [
          { id: uploadId, ref: uploadId, contentType: 'image/png', filename: 'foto.png' },
          { id: pdf.id, ref: pdf.id, contentType: 'application/pdf', filename: 'a.pdf' }
        ]
      })
    })

    it('keeps the text beside the files', async () => {
      const [event] = await plugin.handleWebhook({ ...body, attachments: [png] })
      expect(event?.message).toMatchObject({ type: MessageType.IMAGE, content: 'hola' })
    })

    it('reads nothing from a message with neither text nor files', async () => {
      await expect(
        plugin.handleWebhook({ visitorToken: token, clientMessageId: 'abc-3', attachments: [] })
      ).resolves.toEqual([])
    })

    it('reads nothing from a bad token, an empty text or a bad id', async () => {
      await expect(plugin.handleWebhook({ ...body, visitorToken: 'x.y' })).resolves.toEqual([])
      await expect(plugin.handleWebhook({ ...body, content: '   ' })).resolves.toEqual([])
      await expect(plugin.handleWebhook({ ...body, clientMessageId: 'a b' })).resolves.toEqual([])
      await expect(plugin.handleWebhook({ ...body, content: 'x'.repeat(2001) })).resolves.toEqual(
        []
      )
    })
  })

  describe('fetchMedia', () => {
    const uploadId = '8b1f6a3c-52d4-4e5a-9a3b-7c1d2e3f4a5b'
    const key = `${StorageKeys.messageUploadPrefix('s', uploadId)}foto.png`

    beforeEach(() => jest.resetAllMocks())

    it('reads the object under the upload id in the store of the connection', async () => {
      const stream = {}
      storage.list.mockResolvedValue({ objects: [{ key }], next: undefined })
      storage.head.mockResolvedValue({ contentType: 'image/png', contentLength: 7 })
      storage.stream.mockResolvedValue(stream)

      await expect(plugin.fetchMedia(ctx, uploadId)).resolves.toEqual({
        stream,
        contentType: 'image/png',
        contentLength: 7
      })
      expect(storage.list).toHaveBeenCalledWith(StorageKeys.messageUploadPrefix('s', uploadId))
    })

    it.each(['../x', 'https://a.test/a.png', `${uploadId}/../../other`])(
      'refuses a reference that is not an upload id: %s',
      async ref => {
        await expect(plugin.fetchMedia(ctx, ref)).rejects.toMatchObject({
          code: ErrorCodes.CHANNEL_MESSAGE_FAILED,
          retryable: false
        })
        expect(storage.list).not.toHaveBeenCalled()
      }
    )

    it('fails for good when nothing is under the id', async () => {
      storage.list.mockResolvedValue({ objects: [], next: undefined })
      await expect(plugin.fetchMedia(ctx, uploadId)).rejects.toMatchObject({
        code: ErrorCodes.CHANNEL_MESSAGE_FAILED,
        retryable: false
      })
    })

    it('fails for good when the object is gone between the listing and the read', async () => {
      storage.list.mockResolvedValue({ objects: [{ key }], next: undefined })
      storage.head.mockResolvedValue(null)
      await expect(plugin.fetchMedia(ctx, uploadId)).rejects.toMatchObject({
        code: ErrorCodes.CHANNEL_MESSAGE_FAILED
      })
      // No stream was opened for an object that is gone
      expect(storage.stream).not.toHaveBeenCalled()
    })
  })

  describe('outbound', () => {
    it('accepts a text with the id we gave it', async () => {
      const result = await plugin.sendMessage(ctx, {
        channelIdentity: visitorId,
        content: 'hola',
        idempotencyKey: 'm1'
      })
      expect(result).toMatchObject({ externalId: 'm1', status: DeliveryStatus.SENT })
    })

    it('refuses a video or audio: it declares images and documents only', async () => {
      const error: unknown = await plugin
        .sendMedia(ctx, {
          channelIdentity: visitorId,
          fileSize: 1,
          openFile: sendsByLink,
          contentType: 'video/mp4',
          filename: 'a.mp4',
          idempotencyKey: 'm3'
        })
        .catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(PluginError)
      expect(error).toMatchObject({ code: ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED })
    })

    it('accepts a file with the id we gave it: the visitor asks for the link when they open it', async () => {
      const result = await plugin.sendMedia(ctx, {
        channelIdentity: visitorId,
        fileSize: 1,
        openFile: sendsByLink,
        contentType: 'image/png',
        filename: 'a.png',
        caption: 'tu comprobante',
        idempotencyKey: 'm2'
      })
      expect(result).toMatchObject({ externalId: 'm2', status: DeliveryStatus.SENT })
    })

    it('answers each file of a message with its own id, with or without a text of its own', async () => {
      const send = (idempotencyKey: string, caption?: string) =>
        plugin.sendMedia(ctx, {
          channelIdentity: visitorId,
          fileSize: 1,
          openFile: sendsByLink,
          contentType: 'image/png',
          filename: 'a.png',
          ...(caption === undefined ? {} : { caption }),
          idempotencyKey
        })

      const sent = await Promise.all([send('m-0', 'uno'), send('m-1', 'dos'), send('m-2')])

      expect(sent.map(result => result.externalId)).toEqual(['m-0', 'm-1', 'm-2'])
      // the text reaches the visitor from the api: the plugin neither sends it apart nor answers an id for it
      expect(sent.map(result => result.metadata)).toEqual([undefined, undefined, undefined])
    })

    it('holds a file to what it declares: a size over the limit and a size that makes no sense', async () => {
      const file = (fileSize: number) => ({
        channelIdentity: visitorId,
        fileSize,
        openFile: sendsByLink,
        contentType: 'image/png',
        filename: 'a.png',
        idempotencyKey: 'm5'
      })

      await expect(plugin.sendMedia(ctx, file(10 * 1024 * 1024 + 1))).rejects.toMatchObject({
        code: ErrorCodes.CHANNEL_FILE_TOO_LARGE
      })
      for (const size of [0, -1, 1.5, Number.NaN]) {
        await expect(plugin.sendMedia(ctx, file(size))).rejects.toMatchObject({
          code: ErrorCodes.CHANNEL_MESSAGE_FAILED
        })
      }
      await expect(plugin.sendMedia(ctx, file(10 * 1024 * 1024))).resolves.toMatchObject({
        externalId: 'm5'
      })
    })

    it('declares its rules frozen, the same ones the platform uses for an upload', () => {
      expect(Object.isFrozen(plugin.media)).toBe(true)
      expect(Object.isFrozen(plugin.media.kinds.image?.types)).toBe(true)
      expect(plugin.media.kinds.image?.maxBytes).toBe(10 * 1024 * 1024)
    })
  })
})
