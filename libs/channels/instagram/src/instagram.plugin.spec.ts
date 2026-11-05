import { createHmac } from 'node:crypto'

import { MetaGraphClient, metaTokenCredentialsSchema } from '@platform/channels/meta'
import { InstagramApi, MetaGraph, MetaSubscribableFields } from '@platform/core/domain'
import { ChannelConnectFailureReasons, ErrorCodes, PluginChecks } from '@platform/core/errors'
import {
  type ChannelContext,
  type ChannelPlugin,
  ChannelCapability,
  PluginError
} from '@platform/plugins/sdk'

import { InstagramPlugin } from './instagram.plugin'

// These channels send by link: the file is never opened
const sendsByLink = (): Promise<NodeJS.ReadableStream> =>
  Promise.reject(new Error('this channel sends by link'))

const credentials = { accessToken: 'SUAT-token' }
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

const ACCOUNT = '17841400000000001'

// What `me/assigned_instagram_accounts` answers: the accounts the owner shared with the app
function accounts(...list: { id: string; username: string }[]): { data: typeof list } {
  return { data: list }
}

// The names Meta accepts for the object `instagram`, the same list the connect spec refuses by
const VALID_FIELDS = new Set<string>(MetaSubscribableFields.INSTAGRAM)

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })

const graphError = (status: number, code: number): Response =>
  json(status, { error: { code, type: 'OAuthException', message: 'x' } })

// A Graph that is as strict as the real one for what this plugin calls, and no kinder: only
// Facebook's host, only the routes of the unified login, only field names of the reference, and the
// token of the pair. Whatever else is asked is recorded in `rejected` and answered with an error.
function strictGraph(options: { token: string }): {
  requests: string[]
  calls: string[]
  rejected: string[]
  bodies: unknown[]
  restore: () => void
} {
  const requests: string[] = []
  const calls: string[] = []
  const rejected: string[] = []
  const bodies: unknown[] = []
  const spy = jest.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    )
    const method = init?.method ?? 'GET'
    const line = `${method} ${url.origin}${url.pathname}${url.search}`
    requests.push(line)
    const refuse = (): Response => {
      rejected.push(line)
      return graphError(400, 100)
    }
    if (url.origin !== 'https://graph.facebook.com') return Promise.resolve(refuse())
    const bearer = new Headers(init?.headers).get('authorization')
    if (bearer !== `Bearer ${options.token}`) return Promise.resolve(graphError(401, 190))
    const route = url.pathname.replace(/^\/v\d+\.\d+\//, '')

    if (method === 'GET' && route === 'me/assigned_instagram_accounts') {
      if (
        url.searchParams.get('fields') !== 'id,username' ||
        url.searchParams.get('limit') !== '100'
      ) {
        return Promise.resolve(refuse())
      }
      calls.push(line)
      return Promise.resolve(json(200, accounts({ id: ACCOUNT, username: 'tienda' })))
    }
    if (method === 'POST' && route === `${ACCOUNT}/subscribed_apps`) {
      const fields = (url.searchParams.get('subscribed_fields') ?? '').split(',')
      if (fields.some(field => !VALID_FIELDS.has(field))) return Promise.resolve(refuse())
      calls.push(line)
      return Promise.resolve(json(200, { success: true }))
    }
    if (method === 'POST' && route === `${ACCOUNT}/messages`) {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        recipient?: { id?: string }
        message?: { text?: string }
      }
      if (typeof body.recipient?.id !== 'string' || typeof body.message?.text !== 'string') {
        return Promise.resolve(refuse())
      }
      calls.push(line)
      bodies.push(body)
      return Promise.resolve(json(200, { recipient_id: body.recipient.id, message_id: 'mid.1' }))
    }
    return Promise.resolve(refuse())
  })
  return { requests, calls, rejected, bodies, restore: () => spy.mockRestore() }
}

// The plugin with the real client, for the tests that read what the client checks
function buildReal(): InstagramPlugin {
  return new InstagramPlugin(
    new MetaGraphClient({ appSecret: 's', verifyToken: 'v', graphVersion: 'v23.0' })
  )
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
  // A failed assertion must not leave fetch replaced for the tests that follow
  afterEach(() => jest.restoreAllMocks())

  it('asks, in its connect form, for the one token its credentials need, as a secret', () => {
    const { plugin } = build()
    expect(plugin.connectFields.map(field => field.key)).toEqual(
      Object.keys(metaTokenCredentialsSchema.shape)
    )
    expect(plugin.connectFields.every(field => field.secret && field.required)).toBe(true)
    expect(plugin.receivesProviderWebhooks).toBe(true)
  })

  it('has no step for the owner to take to read profiles', () => {
    expect((build().plugin as ChannelPlugin).profileSetupKey).toBeUndefined()
  })

  it('declares what it can do, with no buttons or templates', () => {
    const { plugin } = build()
    expect(plugin.capabilities).toEqual(
      expect.arrayContaining([
        ChannelCapability.TEXT,
        ChannelCapability.REACTIONS,
        ChannelCapability.REPLY_TO,
        ChannelCapability.CUSTOMER_PROFILE,
        ChannelCapability.TYPING_INDICATOR,
        ChannelCapability.READ_RECEIPTS,
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
    it('subscribes only to names the Instagram API accepts, as Meta does (error 100 otherwise)', async () => {
      const { plugin, get, post } = build()
      get.mockResolvedValue(accounts({ id: '17841400000000001', username: 'tienda' }))
      post.mockImplementation(request => {
        const unknown = (request.query?.subscribed_fields ?? '')
          .split(',')
          .filter(name => !(MetaSubscribableFields.INSTAGRAM as readonly string[]).includes(name))
        return unknown.length === 0
          ? Promise.resolve({ success: true })
          : Promise.reject(new Error(`Param subscribed_fields must be valid: ${unknown.join()}`))
      })

      await expect(plugin.connect({ storeId: 's', credentials })).resolves.toMatchObject({
        connectionId: '17841400000000001'
      })
    })

    it('subscribes to exactly the fields the unified login documents, and not to message_edit', () => {
      expect(InstagramApi.SUBSCRIBED_FIELDS.split(',')).toEqual([
        'messages',
        'message_reactions',
        'messaging_referral'
      ])
      // A valid name of Meta all the same: the strict fake accepts it, the plugin does not ask for it
      expect(MetaSubscribableFields.INSTAGRAM).toContain('message_edit')
    })

    it('trims the spaces and line breaks around a pasted token', async () => {
      const { plugin, get, post } = build()
      get.mockResolvedValue(accounts({ id: '17841400000000001', username: 'tienda' }))
      post.mockResolvedValue({ success: true })

      const result = await plugin.connect({
        storeId: 's',
        credentials: { accessToken: '  SUAT-token\n' }
      })

      expect(get.mock.calls[0]?.[0]).toMatchObject({ token: 'SUAT-token' })
      expect(result.credentials).toEqual({ accessToken: 'SUAT-token' })
    })

    it('names the check that refused when the subscription is not confirmed', async () => {
      const { plugin, get, post } = build()
      get.mockResolvedValue(accounts({ id: '17841400000000001', username: 'tienda' }))
      post.mockResolvedValue({ success: false })

      await expect(plugin.connect({ storeId: 's', credentials })).rejects.toMatchObject({
        code: ErrorCodes.CHANNEL_CREDENTIALS_INVALID,
        failedCheck: PluginChecks.SUBSCRIPTION_NOT_CONFIRMED
      })
    })

    it('names the check that refused when the account id is not digits', async () => {
      const { plugin, get } = build()
      get.mockResolvedValue(accounts({ id: 'me/accounts', username: 'tienda' }))

      await expect(plugin.connect({ storeId: 's', credentials })).rejects.toMatchObject({
        failedCheck: PluginChecks.ACCOUNT_ID_NOT_NUMERIC
      })
    })

    it('names the check that refused when the credentials have no token', async () => {
      const { plugin } = build()

      await expect(
        plugin.connect({ storeId: 's', credentials: { accessToken: '   ' } })
      ).rejects.toMatchObject({ failedCheck: PluginChecks.CREDENTIALS_SHAPE })
    })

    it("reads the account of the token from Facebook's host and subscribes the app to it", async () => {
      const { plugin, get, post } = build()
      get.mockResolvedValue(accounts({ id: '17841400000000001', username: 'tienda' }))
      post.mockResolvedValue({ success: true })

      const result = await plugin.connect({ storeId: 's', credentials })

      // `me` is the system user of the token, not the account: the accounts are one edge below it
      expect(get.mock.calls[0]?.[0]).toMatchObject({
        origin: MetaGraph.ORIGIN,
        path: ['me', 'assigned_instagram_accounts'],
        token: 'SUAT-token',
        query: { fields: 'id,username', limit: '100' }
      })
      expect(post.mock.calls[0]?.[0]).toMatchObject({
        origin: MetaGraph.ORIGIN,
        path: ['17841400000000001', 'subscribed_apps'],
        query: { subscribed_fields: 'messages,message_reactions,messaging_referral' },
        idempotent: true
      })
      expect(result).toEqual({
        connectionId: '17841400000000001',
        displayName: 'tienda',
        credentials,
        metadata: {}
      })
    })

    it.each([
      ['no account at all', { data: [] }, PluginChecks.ACCOUNT_NOT_FOUND],
      [
        'more than one account: the connection is one account, and the owner picks it by the token',
        accounts({ id: '1', username: 'a' }, { id: '2', username: 'b' }),
        PluginChecks.ACCOUNT_AMBIGUOUS
      ],
      [
        'an id that is not digits',
        accounts({ id: '../x', username: 'tienda' }),
        PluginChecks.ACCOUNT_ID_NOT_NUMERIC
      ],
      [
        'the one account with no username',
        { data: [{ id: '1' }] },
        PluginChecks.ACCOUNT_SHAPE_INVALID
      ]
    ])('refuses %s, naming the check, and subscribes nothing', async (_name, answer, check) => {
      const { plugin, get, post } = build()
      get.mockResolvedValue(answer)

      await expect(plugin.connect({ storeId: 's', credentials })).rejects.toMatchObject({
        code: ErrorCodes.CHANNEL_CREDENTIALS_INVALID,
        retryable: false,
        failedCheck: check
      })
      expect(post).not.toHaveBeenCalled()
    })

    it('refuses an id that arrives as a number: 17 digits do not fit one exactly', async () => {
      // Through the real client, which is the one that checks what Meta answers
      const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('{"data":[{"id":17841400000000001,"username":"tienda"}]}', {
          headers: { 'content-type': 'application/json' }
        })
      )
      const real = buildReal()

      await expect(real.connect({ storeId: 's', credentials })).rejects.toMatchObject({
        code: ErrorCodes.CHANNEL_CREDENTIALS_INVALID
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      fetchMock.mockRestore()
    })

    it('treats the answer of the old login, which is not a list of accounts, as an unexpected answer', async () => {
      const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('{"user_id":"1","username":"tienda"}', {
          headers: { 'content-type': 'application/json' }
        })
      )
      const real = buildReal()

      await expect(real.connect({ storeId: 's', credentials })).rejects.toMatchObject({
        code: ErrorCodes.CHANNEL_MESSAGE_FAILED
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      fetchMock.mockRestore()
    })

    it('refuses a subscription Meta did not make', async () => {
      const { plugin, get, post } = build()
      get.mockResolvedValue(accounts({ id: '1', username: 'tienda' }))
      post.mockResolvedValue({ success: false })

      await expect(plugin.connect({ storeId: 's', credentials })).rejects.toMatchObject({
        code: ErrorCodes.CHANNEL_CREDENTIALS_INVALID,
        retryable: false
      })
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

  describe('health', () => {
    it('reports a healthy connection when the token still reaches the account', async () => {
      const { plugin, get } = build()
      get.mockResolvedValue(accounts({ id: ctx.connectionId, username: 'tienda' }))
      await expect(plugin.healthCheck(ctx)).resolves.toMatchObject({ healthy: true })
    })

    it('finds its account among several: a token that gained one later is not a broken one', async () => {
      const { plugin, get } = build()
      get.mockResolvedValue(
        accounts({ id: '999', username: 'otra' }, { id: ctx.connectionId, username: 'tienda' })
      )
      await expect(plugin.healthCheck(ctx)).resolves.toMatchObject({ healthy: true })
    })

    it('does not let an account that is not its own, and is badly shaped, break its health', async () => {
      const { plugin, get } = build()
      get.mockResolvedValue({
        data: [{ id: '999' }, { id: ctx.connectionId, username: 'tienda' }, 'junk']
      })
      await expect(plugin.healthCheck(ctx)).resolves.toMatchObject({ healthy: true })
    })

    it('does not call healthy a token that belongs to another account', async () => {
      const { plugin, get } = build()
      get.mockResolvedValue(accounts({ id: '999', username: 'otra' }))
      await expect(plugin.healthCheck(ctx)).rejects.toMatchObject({
        code: ErrorCodes.CHANNEL_CREDENTIALS_INVALID,
        retryable: false,
        failedCheck: PluginChecks.ACCOUNT_NOT_FOUND
      })
    })

    it('checks the id of the account when the health is checked too', async () => {
      const { plugin, get } = build()
      get.mockResolvedValue(accounts({ id: '../x', username: 'tienda' }))
      await expect(plugin.healthCheck(ctx)).rejects.toMatchObject({
        code: ErrorCodes.CHANNEL_CREDENTIALS_INVALID
      })
    })

    it('tells a legacy token to reconnect, through the real client and a strict Graph', async () => {
      // A token of Instagram Login is not a token of Facebook's host: Meta answers 190
      const graph = strictGraph({ token: 'SUAT-ok' })
      const real = buildReal()

      await expect(
        real.healthCheck({ ...ctx, credentials: { accessToken: 'IGAA-legacy' } })
      ).rejects.toMatchObject({ code: ErrorCodes.CHANNEL_CREDENTIALS_INVALID, retryable: false })
      // The call was made, to Facebook's host and the route of the accounts, and Meta refused the token
      expect(graph.requests).toEqual([
        'GET https://graph.facebook.com/v23.0/me/assigned_instagram_accounts?fields=id%2Cusername&limit=100'
      ])
      expect(graph.rejected).toEqual([])
      graph.restore()
    })

    it('reports healthy through the real client and a strict Graph', async () => {
      const graph = strictGraph({ token: 'SUAT-ok' })

      await expect(
        buildReal().healthCheck({
          ...ctx,
          connectionId: ACCOUNT,
          credentials: { accessToken: 'SUAT-ok' }
        })
      ).resolves.toMatchObject({ healthy: true })
      expect(graph.rejected).toEqual([])
      expect(graph.requests).toHaveLength(1)
      graph.restore()
    })
  })

  describe('against a strict Graph', () => {
    // VALID_FIELDS is `MetaSubscribableFields.INSTAGRAM`; the routes are the ones of the unified login
    // pages (webhooks/setup, get-started step 6).
    // The fake answers like Meta: a wrong host, a wrong route or a field that does not exist is an
    // error, never a success, so a name that is wrong cannot pass the test
    it('connects with the routes, host and field names of the unified login', async () => {
      const graph = strictGraph({ token: 'SUAT-ok' })
      const real = buildReal()

      await expect(
        real.connect({ storeId: 's', credentials: { accessToken: 'SUAT-ok' } })
      ).resolves.toMatchObject({ connectionId: ACCOUNT, displayName: 'tienda' })
      expect(graph.rejected).toEqual([])
      expect(graph.calls).toEqual([
        `GET https://graph.facebook.com/v23.0/me/assigned_instagram_accounts?fields=id%2Cusername&limit=100`,
        `POST https://graph.facebook.com/v23.0/${ACCOUNT}/subscribed_apps?subscribed_fields=messages%2Cmessage_reactions%2Cmessaging_referral`
      ])
      graph.restore()
    })

    it('sends a text on the route of the account, with the customer in the body', async () => {
      const graph = strictGraph({ token: 'SUAT-ok' })
      const real = buildReal()

      await real.sendMessage(
        { ...ctx, connectionId: ACCOUNT, credentials: { accessToken: 'SUAT-ok' } },
        { channelIdentity: '5551234', content: 'Hola', ...key }
      )

      expect(graph.rejected).toEqual([])
      expect(graph.calls).toEqual([`POST https://graph.facebook.com/v23.0/${ACCOUNT}/messages`])
      expect(graph.bodies).toEqual([{ recipient: { id: '5551234' }, message: { text: 'Hola' } }])
      graph.restore()
    })

    it.each([
      ['the host of the old login', 'POST', 'https://graph.instagram.com/v23.0/1/subscribed_apps'],
      ['a route it does not have', 'GET', 'https://graph.facebook.com/v23.0/me'],
      [
        'the accounts without the fields',
        'GET',
        'https://graph.facebook.com/v23.0/me/assigned_instagram_accounts'
      ],
      ['a send with no recipient', 'POST', `https://graph.facebook.com/v23.0/${ACCOUNT}/messages`]
    ])('is refused by the fake itself: %s', async (_name, method, url) => {
      const graph = strictGraph({ token: 'SUAT-ok' })
      const response = await fetch(url, {
        method,
        headers: { authorization: 'Bearer SUAT-ok' },
        ...(method === 'POST' ? { body: '{}' } : {})
      })
      expect(response.status).toBe(400)
      expect(graph.rejected).toHaveLength(1)
      graph.restore()
    })

    it('would be told by the fake, and so by the test, of a name Meta does not know', async () => {
      const graph = strictGraph({ token: 'SUAT-ok' })
      const response = await fetch(
        `https://graph.facebook.com/v23.0/${ACCOUNT}/subscribed_apps?subscribed_fields=messages,messaging_referrals`,
        { method: 'POST', headers: { authorization: 'Bearer SUAT-ok' } }
      )
      expect(response.status).toBe(400)
      expect(graph.rejected).toHaveLength(1)
      graph.restore()
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
        origin: MetaGraph.ORIGIN,
        path: ['17841400000000099'],
        token: 'SUAT-token',
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
        origin: MetaGraph.ORIGIN,
        path: ['17841400000000001', 'messages'],
        token: 'SUAT-token',
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
        fileSize: 1,
        openFile: sendsByLink,
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
          fileSize: 1,
          openFile: sendsByLink,
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
          fileSize: 1,
          openFile: sendsByLink,
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
        fileSize: 1,
        openFile: sendsByLink,
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

    it.each([
      ['a refusal', { retryable: false }, 'failed'],
      ['a throttle', { retryable: true }, 'failed'],
      ['a call with no clear answer', { retryable: false, outcomeUnknown: true }, 'unconfirmed']
    ])(
      'answers with the file and the caption state when only the caption failed: %s',
      async (_name, options, state) => {
        const { plugin, post } = build()
        post
          .mockResolvedValueOnce({ message_id: 'mid.2' })
          .mockRejectedValueOnce(new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, options))

        const result = await plugin.sendMedia(ctx, {
          channelIdentity: '99',
          mediaUrl: 'https://files.example.com/a.png',
          fileSize: 1,
          openFile: sendsByLink,
          contentType: 'image/png',
          filename: null,
          caption: 'mira',
          ...key
        })

        expect(result.externalId).toBe('mid.2')
        expect(result.metadata).toEqual({ captionState: state })
        expect(post).toHaveBeenCalledTimes(2)
      }
    )

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
        origin: MetaGraph.ORIGIN,
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

  describe('sender actions', () => {
    it('sends the typing indicator and the seen mark on the Instagram host, alone', async () => {
      const { plugin, post } = build()
      post.mockResolvedValue({ recipient_id: '99' })

      await plugin.sendTypingIndicator(ctx, { channelIdentity: '99', active: true })
      await plugin.markAsRead(ctx, { channelIdentity: '99', externalId: 'mid.1' })

      expect(post.mock.calls[0]?.[0]).toMatchObject({
        origin: MetaGraph.ORIGIN,
        path: ['17841400000000001', 'messages'],
        idempotent: true,
        body: { recipient: { id: '99' }, sender_action: 'typing_on' }
      })
      expect(post.mock.calls[1]?.[0]).toMatchObject({
        origin: MetaGraph.ORIGIN,
        path: ['17841400000000001', 'messages'],
        idempotent: true,
        body: { recipient: { id: '99' }, sender_action: 'mark_seen' }
      })
    })

    it('takes the typing indicator away with typing_off', async () => {
      const { plugin, post } = build()
      post.mockResolvedValue({ recipient_id: '99' })

      await plugin.sendTypingIndicator(ctx, { channelIdentity: '99', active: false })

      expect(post.mock.calls[0]?.[0].body).toEqual({
        recipient: { id: '99' },
        sender_action: 'typing_off'
      })
    })

    it('lets the failure of Meta reach the caller, which decides what a failure is worth', async () => {
      const { plugin, post } = build()
      post.mockRejectedValue(new Error('meta refused'))

      await expect(
        plugin.sendTypingIndicator(ctx, { channelIdentity: '99', active: true })
      ).rejects.toThrow('meta refused')
      await expect(
        plugin.markAsRead(ctx, { channelIdentity: '99', externalId: 'mid.1' })
      ).rejects.toThrow('meta refused')
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

  describe('the webhook signature', () => {
    const body = '{"object":"instagram","entry":[]}'
    const signed = (secret: string): Record<string, string> => ({
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
    })
    const plugin = (instagramAppSecret?: string): InstagramPlugin =>
      new InstagramPlugin(
        new MetaGraphClient({
          appSecret: 'main-secret',
          verifyToken: 'verify',
          graphVersion: 'v23.0',
          ...(instagramAppSecret === undefined ? {} : { instagramAppSecret })
        })
      )

    it('is the one of the Instagram app when the platform has it, and only that one', () => {
      const own = plugin('instagram-app-secret')
      expect(own.validateWebhookSignature(body, signed('instagram-app-secret'))).toBe(true)
      expect(own.validateWebhookSignature(body, signed('main-secret'))).toBe(false)
    })

    it('is the one of the main app when the platform has no other (one app for the three)', () => {
      const shared = plugin()
      expect(shared.validateWebhookSignature(body, signed('main-secret'))).toBe(true)
      expect(shared.validateWebhookSignature(body, signed('instagram-app-secret'))).toBe(false)
    })

    it('still answers the handshake with the one verify token of the platform', () => {
      const query = { 'hub.mode': 'subscribe', 'hub.verify_token': 'verify', 'hub.challenge': '7' }
      expect(plugin('instagram-app-secret').verifyWebhook(query)).toBe('7')
    })
  })
})

// What the owner reads when connecting fails: a name of a closed list, chosen from the numbers of Meta's
// answer, never from its words (which can echo the token)
describe('InstagramPlugin, the reason a connection fails', () => {
  const realPlugin = (): InstagramPlugin =>
    new InstagramPlugin(
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
