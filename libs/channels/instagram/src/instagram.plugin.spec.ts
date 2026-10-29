import { MetaGraphClient } from '@platform/channels/meta'
import { MetaGraph } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { type ChannelContext, ChannelCapability, PluginError } from '@platform/plugins/sdk'

import { InstagramPlugin } from './instagram.plugin'

const credentials = { accessToken: 'IGAA-token' }
const ctx: ChannelContext = {
  storeId: 's',
  connectionId: '17841400000000001',
  credentials,
  metadata: {}
}
const key = { idempotencyKey: 'k' }

interface GraphCall {
  origin?: string
  path?: string[]
  token?: string
  body?: Record<string, unknown>
  query?: Record<string, string>
}

function build(): {
  plugin: InstagramPlugin
  get: jest.Mock<Promise<unknown>, [GraphCall]>
  post: jest.Mock<Promise<unknown>, [GraphCall]>
  downloadMediaUrl: jest.Mock<Promise<unknown>, [string]>
} {
  const get = jest.fn<Promise<unknown>, [GraphCall]>()
  const post = jest.fn<Promise<unknown>, [GraphCall]>()
  const downloadMediaUrl = jest.fn<Promise<unknown>, [string]>()
  // The plugin only calls these methods of the client, and each one is replaced here
  const meta = { get, post, downloadMediaUrl } as unknown as MetaGraphClient
  return { plugin: new InstagramPlugin(meta), get, post, downloadMediaUrl }
}

describe('InstagramPlugin', () => {
  it('declares what it can do, with no buttons, templates or typing', () => {
    const { plugin } = build()
    expect(plugin.capabilities).toEqual(
      expect.arrayContaining([
        ChannelCapability.TEXT,
        ChannelCapability.REACTIONS,
        ChannelCapability.REPLY_TO,
        ChannelCapability.CUSTOMER_PROFILE,
        ChannelCapability.MESSAGING_WINDOW
      ])
    )
    expect(plugin.capabilities).not.toContain(ChannelCapability.BUTTONS)
    expect(plugin.capabilities).not.toContain(ChannelCapability.TEMPLATES)
    expect(plugin.messagingWindow).toEqual({
      hours: 24,
      requiresTemplateWhenClosed: false,
      extendedHoursAfterAd: 168
    })
  })

  describe('connect', () => {
    it('reads the account from the Instagram host and subscribes the app to it', async () => {
      const { plugin, get, post } = build()
      get.mockResolvedValue({ user_id: '17841400000000001', username: 'tienda' })
      post.mockResolvedValue({ success: true })

      const result = await plugin.connect({ storeId: 's', credentials })

      expect(get.mock.calls[0]?.[0]).toMatchObject({
        origin: MetaGraph.INSTAGRAM_ORIGIN,
        path: ['me'],
        token: 'IGAA-token',
        query: { fields: 'user_id,username' }
      })
      expect(post.mock.calls[0]?.[0]).toMatchObject({
        origin: MetaGraph.INSTAGRAM_ORIGIN,
        path: ['17841400000000001', 'subscribed_apps'],
        query: { subscribed_fields: 'messages,messaging_referrals,messaging_reactions' },
        idempotent: true
      })
      expect(result).toEqual({
        connectionId: '17841400000000001',
        displayName: 'tienda',
        credentials,
        metadata: {}
      })
    })

    it('reads the profile when Meta wraps it in a list', async () => {
      const { plugin, get, post } = build()
      get.mockResolvedValue({ data: [{ user_id: '12345', username: 'tienda' }] })
      post.mockResolvedValue({ success: true })

      await expect(plugin.connect({ storeId: 's', credentials })).resolves.toMatchObject({
        connectionId: '12345'
      })
    })

    it.each([['an id that is not digits', { user_id: '../x', username: 'tienda' }]])(
      'refuses %s',
      async (_name, profile) => {
        const { plugin, get, post } = build()
        get.mockResolvedValue(profile)

        await expect(plugin.connect({ storeId: 's', credentials })).rejects.toMatchObject({
          code: ErrorCodes.CHANNEL_CREDENTIALS_INVALID
        })
        expect(post).not.toHaveBeenCalled()
      }
    )

    it('reads the flat profile even when a data key comes beside it', async () => {
      const { plugin, get, post } = build()
      get.mockResolvedValue({ user_id: '777', username: 'tienda', data: [] })
      post.mockResolvedValue({ success: true })

      await expect(plugin.connect({ storeId: 's', credentials })).resolves.toMatchObject({
        connectionId: '777'
      })
    })

    it('refuses an id that arrives as a number: 17 digits do not fit one exactly', async () => {
      // Through the real client, which is the one that checks what Meta answers
      const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('{"user_id":17841400000000001,"username":"tienda"}', {
          headers: { 'content-type': 'application/json' }
        })
      )
      const real = new InstagramPlugin(
        new MetaGraphClient({ appSecret: 's', verifyToken: 'v', graphVersion: 'v23.0' })
      )

      await expect(real.connect({ storeId: 's', credentials })).rejects.toBeInstanceOf(PluginError)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      fetchMock.mockRestore()
    })

    it('checks the id of the account when the health is checked too', async () => {
      const { plugin, get } = build()
      get.mockResolvedValue({ user_id: '../x', username: 'tienda' })
      await expect(plugin.healthCheck(ctx)).rejects.toMatchObject({
        code: ErrorCodes.CHANNEL_CREDENTIALS_INVALID
      })
    })

    it('refuses a subscription Meta did not make', async () => {
      const { plugin, get, post } = build()
      get.mockResolvedValue({ user_id: '1', username: 'tienda' })
      post.mockResolvedValue({ success: false })

      await expect(plugin.connect({ storeId: 's', credentials })).rejects.toBeInstanceOf(
        PluginError
      )
    })

    it.each([[{}], [{ accessToken: '' }], [{ accessToken: 5 }]])(
      'refuses credentials of the wrong shape (%j) without calling Meta',
      async bad => {
        const { plugin, get } = build()
        await expect(plugin.connect({ storeId: 's', credentials: bad })).rejects.toMatchObject({
          code: ErrorCodes.CHANNEL_CREDENTIALS_INVALID,
          retryable: false
        })
        expect(get).not.toHaveBeenCalled()
      }
    )
  })

  it('reports a healthy connection after reading the account', async () => {
    const { plugin, get } = build()
    get.mockResolvedValue({ user_id: ctx.connectionId, username: 'tienda' })
    await expect(plugin.healthCheck(ctx)).resolves.toMatchObject({ healthy: true })
  })

  it('does not call healthy a token that belongs to another account', async () => {
    const { plugin, get } = build()
    get.mockResolvedValue({ user_id: '999', username: 'otra' })
    await expect(plugin.healthCheck(ctx)).rejects.toMatchObject({
      code: ErrorCodes.CHANNEL_CREDENTIALS_INVALID,
      retryable: false
    })
  })

  describe('fetchProfile', () => {
    it('reads the name, username and photo of the person from the Instagram host', async () => {
      const { plugin, get } = build()
      get.mockResolvedValue({
        name: ' Peter Chang ',
        username: 'peter_chang_live',
        profile_pic: 'https://fbcdn.example/p.jpg'
      })

      const profile = await plugin.fetchProfile(ctx, '17841400000000099')

      expect(get.mock.calls[0]?.[0]).toMatchObject({
        origin: MetaGraph.INSTAGRAM_ORIGIN,
        path: ['17841400000000099'],
        token: 'IGAA-token',
        query: { fields: 'name,username,profile_pic' }
      })
      expect(profile).toEqual({
        name: 'Peter Chang',
        username: 'peter_chang_live',
        avatarUrl: 'https://fbcdn.example/p.jpg'
      })
    })

    it('keeps what is there when the name is null', async () => {
      const { plugin, get } = build()
      get.mockResolvedValue({ name: null, username: 'peter' })
      expect(await plugin.fetchProfile(ctx, '17841400000000099')).toEqual({ username: 'peter' })
    })

    it('has no profile for an empty answer', async () => {
      const { plugin, get } = build()
      get.mockResolvedValue({})
      expect(await plugin.fetchProfile(ctx, '17841400000000099')).toBeNull()
    })

    it('drops a photo that is not a plain https link', async () => {
      const { plugin, get } = build()
      get.mockResolvedValue({ username: 'peter', profile_pic: 'http://fbcdn.example/p.jpg' })
      expect(await plugin.fetchProfile(ctx, '17841400000000099')).toEqual({ username: 'peter' })
    })

    it('has no profile when the only thing Meta gave is a photo link it cannot keep', async () => {
      const { plugin, get } = build()
      get.mockResolvedValue({ profile_pic: 'http://fbcdn.example/p.jpg' })
      expect(await plugin.fetchProfile(ctx, '17841400000000099')).toBeNull()
    })

    it('has no profile when Meta says there is none, and raises any other failure', async () => {
      const { plugin, get } = build()
      get.mockRejectedValueOnce(new PluginError(ErrorCodes.CHANNEL_PROFILE_UNAVAILABLE))
      expect(await plugin.fetchProfile(ctx, '17841400000000099')).toBeNull()
      get.mockRejectedValueOnce(new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID))
      await expect(plugin.fetchProfile(ctx, '17841400000000099')).rejects.toMatchObject({
        code: ErrorCodes.CHANNEL_CREDENTIALS_INVALID
      })
    })

    it('does not put an id that is not digits into a path', async () => {
      const { plugin, get } = build()
      expect(await plugin.fetchProfile(ctx, '../me')).toBeNull()
      expect(get).not.toHaveBeenCalled()
    })
  })

  describe('sends', () => {
    it('sends a text to the account of the connection, on the Instagram host', async () => {
      const { plugin, post } = build()
      post.mockResolvedValue({ recipient_id: '99', message_id: 'mid.1' })

      const result = await plugin.sendMessage(ctx, {
        channelIdentity: '99',
        content: 'hola',
        ...key
      })

      expect(post.mock.calls[0]?.[0]).toMatchObject({
        origin: MetaGraph.INSTAGRAM_ORIGIN,
        path: ['17841400000000001', 'messages'],
        token: 'IGAA-token',
        body: { recipient: { id: '99' }, message: { text: 'hola' } }
      })
      expect(post.mock.calls[0]?.[0].body).not.toHaveProperty('reply_to')
      expect(result).toMatchObject({ externalId: 'mid.1', status: 'sent' })
    })

    it('replies to a message beside the message, as the reference writes it', async () => {
      const { plugin, post } = build()
      post.mockResolvedValue({ message_id: 'mid.1' })

      await plugin.sendMessage(ctx, {
        channelIdentity: '99',
        content: 'hola',
        replyToExternalId: 'mid.0',
        ...key
      })

      expect(post.mock.calls[0]?.[0].body).toMatchObject({ reply_to: { mid: 'mid.0' } })
    })

    it('sends a file by its url under the key Instagram writes', async () => {
      const { plugin, post } = build()
      post.mockResolvedValue({ message_id: 'mid.2' })

      await plugin.sendMedia(ctx, {
        channelIdentity: '99',
        mediaUrl: 'https://files.example.com/a.png',
        contentType: 'image/png',
        filename: 'a.png',
        ...key
      })

      expect(post).toHaveBeenCalledTimes(1)
      expect(post.mock.calls[0]?.[0].body).toMatchObject({
        message: {
          attachments: { type: 'image', payload: { url: 'https://files.example.com/a.png' } }
        }
      })
    })

    it.each([
      ['a voice note', 'audio/ogg'],
      ['a pdf', 'application/pdf']
    ])('refuses %s: the channel does not declare it', async (_name, contentType) => {
      const { plugin, post } = build()

      await expect(
        plugin.sendMedia(ctx, {
          channelIdentity: '99',
          mediaUrl: 'https://files.example.com/a',
          contentType,
          filename: null,
          ...key
        })
      ).rejects.toMatchObject({ code: ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED, retryable: false })
      expect(post).not.toHaveBeenCalled()
    })

    it.each([
      ['plain http', 'http://files.example.com/a.png'],
      ['credentials in the url', 'https://user:pw@files.example.com/a.png'],
      ['text that is not a url', 'not a url']
    ])('refuses a file at %s without calling Meta', async (_name, mediaUrl) => {
      const { plugin, post } = build()

      await expect(
        plugin.sendMedia(ctx, {
          channelIdentity: '99',
          mediaUrl,
          contentType: 'image/png',
          filename: null,
          ...key
        })
      ).rejects.toMatchObject({ retryable: false })
      expect(post).not.toHaveBeenCalled()
    })

    it('sends the caption as its own message after the file', async () => {
      const { plugin, post } = build()
      post
        .mockResolvedValueOnce({ message_id: 'mid.2' })
        .mockResolvedValueOnce({ message_id: 'mid.3' })

      const result = await plugin.sendMedia(ctx, {
        channelIdentity: '99',
        mediaUrl: 'https://files.example.com/a.png',
        contentType: 'image/png',
        filename: 'a.png',
        caption: 'tu factura',
        ...key
      })

      expect(post.mock.calls[0]?.[0].body).toMatchObject({
        message: { attachments: { type: 'image' } }
      })
      expect(post.mock.calls[1]?.[0].body).toMatchObject({ message: { text: 'tu factura' } })
      expect(result.externalId).toBe('mid.2')
      expect(result.metadata).toEqual({ captionExternalId: 'mid.3' })
    })

    it('does not ask for a second try when only the caption failed: the file is already sent', async () => {
      const { plugin, post } = build()
      post
        .mockResolvedValueOnce({ message_id: 'mid.2' })
        .mockRejectedValueOnce(
          new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: true })
        )

      await expect(
        plugin.sendMedia(ctx, {
          channelIdentity: '99',
          mediaUrl: 'https://files.example.com/a.png',
          contentType: 'image/png',
          filename: null,
          caption: 'mira',
          ...key
        })
      ).rejects.toMatchObject({ code: ErrorCodes.CHANNEL_MESSAGE_FAILED, retryable: false })
    })

    it('reacts, changes the emoji and takes it back with the sender actions of Meta', async () => {
      const { plugin, post } = build()
      post.mockResolvedValue({ recipient_id: '99' })

      await plugin.sendReaction(ctx, {
        channelIdentity: '99',
        targetExternalId: 'mid.1',
        emoji: '❤️'
      })
      await plugin.sendReaction(ctx, {
        channelIdentity: '99',
        targetExternalId: 'mid.1',
        emoji: null
      })

      expect(post.mock.calls[0]?.[0]).toMatchObject({
        origin: MetaGraph.INSTAGRAM_ORIGIN,
        path: ['17841400000000001', 'messages'],
        idempotent: true,
        body: {
          recipient: { id: '99' },
          sender_action: 'react',
          payload: { message_id: 'mid.1', reaction: '❤️' }
        }
      })
      expect(post.mock.calls[1]?.[0].body).toEqual({
        recipient: { id: '99' },
        sender_action: 'unreact',
        payload: { message_id: 'mid.1' }
      })
    })
  })

  it('downloads a file from the url of the webhook', async () => {
    const { plugin, downloadMediaUrl } = build()
    downloadMediaUrl.mockResolvedValue({ contentType: 'image/jpeg' })
    await plugin.fetchMedia(ctx, 'https://scontent.cdninstagram.com/a.jpg')
    expect(downloadMediaUrl).toHaveBeenCalledWith('https://scontent.cdninstagram.com/a.jpg')
  })

  it('reads the webhook of its own object only', async () => {
    const { plugin } = build()
    const body = (object: string): object => ({
      object,
      entry: [
        {
          id: '17841400000000001',
          messaging: [
            {
              sender: { id: '99' },
              recipient: { id: '17841400000000001' },
              timestamp: 1_761_600_000_000,
              message: { mid: 'm1', text: 'hola' }
            }
          ]
        }
      ]
    })
    await expect(plugin.handleWebhook(body('instagram'))).resolves.toHaveLength(1)
    await expect(plugin.handleWebhook(body('page'))).resolves.toEqual([])
  })
})
