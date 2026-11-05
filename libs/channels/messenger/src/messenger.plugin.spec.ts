import { MetaGraphClient, metaTokenCredentialsSchema } from '@platform/channels/meta'
import { ChannelSetupStepKeys, MetaGraph, MetaSubscribableFields } from '@platform/core/domain'
import { ChannelConnectFailureReasons, ErrorCodes } from '@platform/core/errors'
import { type ChannelContext, ChannelCapability, PluginError } from '@platform/plugins/sdk'

import { MessengerPlugin } from './messenger.plugin'

// These channels send by link: the file is never opened
const sendsByLink = (): Promise<NodeJS.ReadableStream> =>
  Promise.reject(new Error('this channel sends by link'))

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
  schema?: { parse: (value: unknown) => unknown }
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
  it('asks, in its connect form, for the one token its credentials need, as a secret', () => {
    const { plugin } = build()
    expect(plugin.connectFields.map(field => field.key)).toEqual(
      Object.keys(metaTokenCredentialsSchema.shape)
    )
    expect(plugin.connectFields.every(field => field.secret && field.required)).toBe(true)
    expect(plugin.receivesProviderWebhooks).toBe(true)
  })

  it('names the step the owner takes on the Page so that customer profiles can be read', () => {
    expect(build().plugin.profileSetupKey).toBe(ChannelSetupStepKeys.MESSENGER_PROFILE_ACCESS)
  })

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
      get.mockResolvedValueOnce({ id: '1090000000000001' })
      get.mockResolvedValueOnce({ id: '1090000000000001', name: 'Mi Tienda' })
      post.mockResolvedValue({ success: true })

      const result = await plugin.connect({ storeId: 's', credentials })

      // The id first, alone: it needs no permission. The name is a second, separate read.
      expect(get.mock.calls[0]?.[0]).toMatchObject({
        origin: MetaGraph.ORIGIN,
        path: ['me'],
        query: { fields: 'id' }
      })
      expect(get.mock.calls[1]?.[0]).toMatchObject({ path: ['me'], query: { fields: 'id,name' } })
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

    it('subscribes only to names the Messenger API accepts, as Meta does (error 100 otherwise)', async () => {
      const { plugin, get, post } = build()
      get.mockResolvedValue({ id: '1090000000000001', name: 'Mi Tienda' })
      post.mockImplementation(request => {
        const unknown = (request.query?.subscribed_fields ?? '')
          .split(',')
          .filter(name => !(MetaSubscribableFields.MESSENGER as readonly string[]).includes(name))
        return unknown.length === 0
          ? Promise.resolve({ success: true })
          : Promise.reject(new Error(`Param subscribed_fields must be valid: ${unknown.join()}`))
      })

      await expect(plugin.connect({ storeId: 's', credentials })).resolves.toMatchObject({
        connectionId: '1090000000000001'
      })
    })

    it('connects with the fallback name when Meta answers the name read with an id and no name', async () => {
      const { plugin, get, post } = build()
      // The real client validates the answer with the schema of the call: a 200 without `name` must pass it
      get.mockImplementation(request =>
        Promise.resolve(request.schema?.parse({ id: '1090000000000001' }))
      )
      post.mockResolvedValue({ success: true })

      await expect(plugin.connect({ storeId: 's', credentials })).resolves.toMatchObject({
        displayName: 'Messenger 1090000000000001'
      })
    })

    it('connects with a fallback name when the token cannot read the name of the Page', async () => {
      const { plugin, get, post } = build()
      // Error 100 of a token without pages_read_engagement: the id was readable, the name was not
      get.mockResolvedValueOnce({ id: '1090000000000001' })
      get.mockRejectedValueOnce(
        new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: false, providerCode: 100 })
      )
      post.mockResolvedValue({ success: true })

      const result = await plugin.connect({ storeId: 's', credentials })

      expect(result).toMatchObject({
        connectionId: '1090000000000001',
        displayName: 'Messenger 1090000000000001'
      })
    })

    it.each([
      ['a throttle', { retryable: true, providerCode: 4 }],
      ['an outage', { retryable: false, outcomeUnknown: true }],
      ['a revoked token', { retryable: false, providerCode: 190 }]
    ])('does not hide %s behind the fallback name', async (_label, options) => {
      const { plugin, get, post } = build()
      get.mockResolvedValueOnce({ id: '1090000000000001' })
      get.mockRejectedValueOnce(new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, options))

      await expect(plugin.connect({ storeId: 's', credentials })).rejects.toBeInstanceOf(
        PluginError
      )
      expect(post).not.toHaveBeenCalled()
    })

    it('uses the fallback name for a permission error too (code 200)', async () => {
      const { plugin, get, post } = build()
      get.mockResolvedValueOnce({ id: '1090000000000001' })
      get.mockRejectedValueOnce(
        new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, {
          retryable: false,
          providerCode: 200
        })
      )
      post.mockResolvedValue({ success: true })

      await expect(plugin.connect({ storeId: 's', credentials })).resolves.toMatchObject({
        displayName: 'Messenger 1090000000000001'
      })
    })

    it('uses the fallback name when the name answer belongs to another id', async () => {
      const { plugin, get, post } = build()
      get.mockResolvedValueOnce({ id: '1090000000000001' })
      get.mockResolvedValueOnce({ id: '999', name: 'Otra' })
      post.mockResolvedValue({ success: true })

      await expect(plugin.connect({ storeId: 's', credentials })).resolves.toMatchObject({
        displayName: 'Messenger 1090000000000001'
      })
    })

    it('uses the fallback name when the Page has an empty name', async () => {
      const { plugin, get, post } = build()
      get.mockResolvedValueOnce({ id: '1090000000000001' })
      get.mockResolvedValueOnce({ id: '1090000000000001', name: '' })
      post.mockResolvedValue({ success: true })

      await expect(plugin.connect({ storeId: 's', credentials })).resolves.toMatchObject({
        displayName: 'Messenger 1090000000000001'
      })
    })

    it('refuses the token when even the id cannot be read', async () => {
      const { plugin, get, post } = build()
      get.mockRejectedValue(
        new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, { retryable: false })
      )

      await expect(plugin.connect({ storeId: 's', credentials })).rejects.toMatchObject({
        code: ErrorCodes.CHANNEL_CREDENTIALS_INVALID
      })
      expect(post).not.toHaveBeenCalled()
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

  it('reads only the id for the health check, which needs no permission for the name', async () => {
    const { plugin, get } = build()
    get.mockResolvedValueOnce({ id: ctx.connectionId })

    await expect(plugin.healthCheck(ctx)).resolves.toMatchObject({ healthy: true })

    expect(get).toHaveBeenCalledTimes(1)
    expect(get.mock.calls[0]?.[0]).toMatchObject({ query: { fields: 'id' } })
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
        fileSize: 1,
        openFile: sendsByLink,
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

  describe('sender actions', () => {
    it('shows and takes away the typing indicator, alone and safe to repeat', async () => {
      const { plugin, post } = build()
      post.mockResolvedValue({ recipient_id: '99' })

      await plugin.sendTypingIndicator(ctx, { channelIdentity: '99', active: true })
      await plugin.sendTypingIndicator(ctx, { channelIdentity: '99', active: false })

      expect(post.mock.calls[0]?.[0]).toMatchObject({
        path: ['1090000000000001', 'messages'],
        idempotent: true,
        body: { recipient: { id: '99' }, sender_action: 'typing_on' }
      })
      expect(post.mock.calls[1]?.[0].body).toEqual({
        recipient: { id: '99' },
        sender_action: 'typing_off'
      })
    })

    it('marks the conversation as seen, whatever the message', async () => {
      const { plugin, post } = build()
      post.mockResolvedValue({ recipient_id: '99' })

      await plugin.markAsRead(ctx, { channelIdentity: '99', externalId: 'm_1' })

      expect(post.mock.calls[0]?.[0].body).toEqual({
        recipient: { id: '99' },
        sender_action: 'mark_seen'
      })
    })

    it('declares both capabilities', () => {
      const { plugin } = build()
      expect(plugin.capabilities).toEqual(
        expect.arrayContaining([
          ChannelCapability.TYPING_INDICATOR,
          ChannelCapability.READ_RECEIPTS
        ])
      )
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

// What the owner reads when connecting fails: a name of a closed list, chosen from the numbers of Meta's
// answer, never from its words (which can echo the token)
describe('MessengerPlugin, the reason a connection fails', () => {
  const realPlugin = (): MessengerPlugin =>
    new MessengerPlugin(
      new MetaGraphClient({ appSecret: 's', verifyToken: 'v', graphVersion: 'v23.0' })
    )
  const answer = (status: number, code: number): Response =>
    new Response(
      JSON.stringify({
        error: { message: 'Invalid token EAAB-page-token', code, type: 'OAuthException' }
      }),
      { status, headers: { 'content-type': 'application/json' } }
    )
  afterEach(() => jest.restoreAllMocks())

  it.each([
    [400, 190, ChannelConnectFailureReasons.TOKEN_REJECTED],
    [400, 200, ChannelConnectFailureReasons.PERMISSION_MISSING],
    [400, 100, ChannelConnectFailureReasons.REQUEST_REJECTED],
    [400, 4, ChannelConnectFailureReasons.PROVIDER_BUSY],
    [500, 1, ChannelConnectFailureReasons.PROVIDER_UNAVAILABLE]
  ])(
    'says it for Meta answering HTTP %i with the code %i, and nothing of its words',
    async (status, code, reason) => {
      jest
        .spyOn(globalThis, 'fetch')
        .mockImplementation(() => Promise.resolve(answer(status, code)))

      const failure: unknown = await realPlugin()
        .connect({ storeId: 's', credentials })
        .catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(PluginError)
      expect(failure).toMatchObject({ reason })
      expect(
        JSON.stringify([(failure as PluginError).message, (failure as PluginError).reason])
      ).not.toContain('EAAB-page-token')
    }
  )

  it('says the token is missing when none was pasted, without asking Meta', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch')

    await expect(
      realPlugin().connect({ storeId: 's', credentials: { accessToken: '   ' } })
    ).rejects.toMatchObject({ reason: ChannelConnectFailureReasons.TOKEN_MISSING })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
