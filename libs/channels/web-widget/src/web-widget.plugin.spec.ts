import {
  ChannelIds,
  DeliveryStatus,
  MessageType,
  WIDGET_TOKEN_HEADER,
  WidgetMetadataKeys
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
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
const plugin = new WebWidgetPlugin({ tokenKey })
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

    it('reads nothing from a bad token, an empty text or a bad id', async () => {
      await expect(plugin.handleWebhook({ ...body, visitorToken: 'x.y' })).resolves.toEqual([])
      await expect(plugin.handleWebhook({ ...body, content: '   ' })).resolves.toEqual([])
      await expect(plugin.handleWebhook({ ...body, clientMessageId: 'a b' })).resolves.toEqual([])
      await expect(plugin.handleWebhook({ ...body, content: 'x'.repeat(2001) })).resolves.toEqual(
        []
      )
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
