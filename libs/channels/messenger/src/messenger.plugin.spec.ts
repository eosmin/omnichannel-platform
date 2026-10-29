import { type MetaGraphClient } from '@platform/channels/meta'
import { MetaGraph } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { type ChannelContext, ChannelCapability } from '@platform/plugins/sdk'

import { MessengerPlugin } from './messenger.plugin'

const credentials = { accessToken: 'EAAB-page-token' }
const ctx: ChannelContext = {
  storeId: 's',
  connectionId: '1090000000000001',
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
  plugin: MessengerPlugin
  get: jest.Mock<Promise<unknown>, [GraphCall]>
  post: jest.Mock<Promise<unknown>, [GraphCall]>
} {
  const get = jest.fn<Promise<unknown>, [GraphCall]>()
  const post = jest.fn<Promise<unknown>, [GraphCall]>()
  // The plugin only calls these methods of the client, and each one is replaced here
  return { plugin: new MessengerPlugin({ get, post } as unknown as MetaGraphClient), get, post }
}

describe('MessengerPlugin', () => {
  it('declares what it can do, with no buttons', () => {
    const { plugin } = build()
    expect(plugin.capabilities).toEqual(
      expect.arrayContaining([
        ChannelCapability.TEXT,
        ChannelCapability.DOCUMENT,
        ChannelCapability.REACTIONS,
        ChannelCapability.MESSAGING_WINDOW
      ])
    )
    expect(plugin.capabilities).not.toContain(ChannelCapability.BUTTONS)
    expect(plugin.capabilities).toContain(ChannelCapability.REPLY_TO)
    expect(plugin.messagingWindow.extendedHoursAfterAd).toBe(168)
  })

  describe('connect', () => {
    it('reads the Page of the token and subscribes the app to it', async () => {
      const { plugin, get, post } = build()
      get.mockResolvedValue({ id: '1090000000000001', name: 'Mi Tienda' })
      post.mockResolvedValue({ success: true })

      const result = await plugin.connect({ storeId: 's', credentials })

      expect(get.mock.calls[0]?.[0]).toMatchObject({
        origin: MetaGraph.ORIGIN,
        path: ['me'],
        query: { fields: 'id,name' }
      })
      expect(post.mock.calls[0]?.[0]).toMatchObject({
        path: ['1090000000000001', 'subscribed_apps'],
        query: {
          subscribed_fields:
            'messages,message_echoes,message_reactions,message_edits,messaging_referrals'
        }
      })
      expect(result).toEqual({
        connectionId: '1090000000000001',
        displayName: 'Mi Tienda',
        credentials,
        metadata: {}
      })
    })

    it('refuses a Page id that is not digits, before it reaches a path', async () => {
      const { plugin, get, post } = build()
      get.mockResolvedValue({ id: 'me/accounts', name: 'x' })

      await expect(plugin.connect({ storeId: 's', credentials })).rejects.toMatchObject({
        code: ErrorCodes.CHANNEL_CREDENTIALS_INVALID
      })
      expect(post).not.toHaveBeenCalled()
    })
  })

  describe('sends', () => {
    it('sends a text as a response, replying to a message beside it', async () => {
      const { plugin, post } = build()
      post.mockResolvedValue({ recipient_id: '99', message_id: 'm_1' })

      const result = await plugin.sendMessage(ctx, {
        channelIdentity: '99',
        content: 'hola',
        replyToExternalId: 'm_0',
        ...key
      })

      expect(post.mock.calls[0]?.[0]).toMatchObject({
        origin: MetaGraph.ORIGIN,
        path: ['1090000000000001', 'messages'],
        body: { recipient: { id: '99' }, messaging_type: 'RESPONSE', message: { text: 'hola' } }
      })
      expect(post.mock.calls[0]?.[0].body).toMatchObject({ reply_to: { mid: 'm_0' } })
      expect(result).toMatchObject({ externalId: 'm_1', status: 'sent' })
    })

    it('sends a file under the key the Messenger Platform writes', async () => {
      const { plugin, post } = build()
      post.mockResolvedValue({ message_id: 'm_2' })

      await plugin.sendMedia(ctx, {
        channelIdentity: '99',
        mediaUrl: 'https://files.example.com/a.mp4',
        contentType: 'video/mp4',
        filename: null,
        ...key
      })

      expect(post.mock.calls[0]?.[0].body).toMatchObject({
        message: {
          attachment: { type: 'video', payload: { url: 'https://files.example.com/a.mp4' } }
        }
      })
    })

    it('reacts through the Page', async () => {
      const { plugin, post } = build()
      post.mockResolvedValue({ recipient_id: '99' })

      await plugin.sendReaction(ctx, {
        channelIdentity: '99',
        targetExternalId: 'm_1',
        emoji: '👍'
      })

      expect(post.mock.calls[0]?.[0]).toMatchObject({
        path: ['1090000000000001', 'messages'],
        body: { sender_action: 'react', payload: { message_id: 'm_1', reaction: '👍' } }
      })
    })
  })

  it('reports a healthy connection only for the Page the connection is', async () => {
    const { plugin, get } = build()
    get.mockResolvedValueOnce({ id: ctx.connectionId, name: 'Mi Tienda' })
    await expect(plugin.healthCheck(ctx)).resolves.toMatchObject({ healthy: true })

    get.mockResolvedValueOnce({ id: '999', name: 'Otra' })
    await expect(plugin.healthCheck(ctx)).rejects.toMatchObject({
      code: ErrorCodes.CHANNEL_CREDENTIALS_INVALID,
      retryable: false
    })
  })

  it('reads the webhook of a Page only', async () => {
    const { plugin } = build()
    const body = (object: string): object => ({
      object,
      entry: [
        {
          id: '1090000000000001',
          messaging: [
            {
              sender: { id: '99' },
              recipient: { id: '1090000000000001' },
              timestamp: 1_761_600_000_000,
              message: { mid: 'm_1', text: 'hola' }
            }
          ]
        }
      ]
    })
    await expect(plugin.handleWebhook(body('page'))).resolves.toHaveLength(1)
    await expect(plugin.handleWebhook(body('instagram'))).resolves.toEqual([])
  })

  describe('fetchProfile', () => {
    it('joins the first and last name and reads from the Facebook host', async () => {
      const { plugin, get } = build()
      get.mockResolvedValue({
        first_name: 'Peter',
        last_name: 'Chang',
        profile_pic: 'https://fbcdn.example/p.jpg'
      })

      const profile = await plugin.fetchProfile(ctx, '3000000000000001')

      expect(get.mock.calls[0]?.[0]).toMatchObject({
        origin: MetaGraph.ORIGIN,
        path: ['3000000000000001'],
        token: 'EAAB-page-token',
        query: { fields: 'first_name,last_name,profile_pic' }
      })
      expect(profile).toEqual({ name: 'Peter Chang', avatarUrl: 'https://fbcdn.example/p.jpg' })
    })

    it('has no profile when the app may not read it: Meta answers an empty object', async () => {
      const { plugin, get } = build()
      get.mockResolvedValue({})
      expect(await plugin.fetchProfile(ctx, '3000000000000001')).toBeNull()
    })

    it('trims each part of the name before joining them', async () => {
      const { plugin, get } = build()
      get.mockResolvedValue({ first_name: ' Peter ', last_name: ' Chang ' })
      expect(await plugin.fetchProfile(ctx, '3000000000000001')).toEqual({ name: 'Peter Chang' })
      get.mockResolvedValue({ first_name: ' ', last_name: 'Chang' })
      expect(await plugin.fetchProfile(ctx, '3000000000000001')).toEqual({ name: 'Chang' })
    })

    it('keeps the one name Meta gave', async () => {
      const { plugin, get } = build()
      get.mockResolvedValue({ first_name: 'Peter', last_name: '' })
      expect(await plugin.fetchProfile(ctx, '3000000000000001')).toEqual({ name: 'Peter' })
    })
  })
})
