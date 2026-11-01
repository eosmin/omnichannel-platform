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
  it('declares text, typing and read receipts, with no window', () => {
    expect(plugin.id).toBe(ChannelIds.WEB_WIDGET)
    expect(plugin.capabilities).toEqual([
      ChannelCapability.TEXT,
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
          { ref: uploadId, contentType: 'image/png', filename: 'foto.png' },
          { ref: pdf.id, contentType: 'application/pdf', filename: 'a.pdf' }
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

    it('refuses media: nothing stores it yet', async () => {
      const error: unknown = await plugin
        .sendMedia(ctx, {
          channelIdentity: visitorId,
          mediaUrl: 'https://a.test/a.png',
          contentType: 'image/png',
          filename: null,
          idempotencyKey: 'm2'
        })
        .catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(PluginError)
      expect(error).toMatchObject({ code: ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED })
    })
  })
})
