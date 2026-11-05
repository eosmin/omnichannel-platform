import { createHmac } from 'node:crypto'

import { MetaGraphClient, metaTokenCredentialsSchema } from '@platform/channels/meta'
import { InstagramApi, MetaGraph, MetaSubscribableFields } from '@platform/core/domain'
import { ErrorCodes, PluginChecks } from '@platform/core/errors'
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

const credentials = { accessToken: 'PAGE-token' }
const PAGE = '110000000000001'
const ACCOUNT = '17841400000000001'
const ctx: ChannelContext = {
  storeId: 's',
  connectionId: ACCOUNT,
  credentials,
  metadata: { pageId: PAGE }
}
const key = { idempotencyKey: 'k' }

interface GraphCall {
  origin?: string
  path?: string[]
  token?: string
  body?: Record<string, unknown>
  query?: Record<string, string>
}

// What `me` answers with the token of a Page: the Page, and the one account it links
function page(
  account: unknown = { id: ACCOUNT, username: 'tienda' },
  id: string = PAGE
): Record<string, unknown> {
  return { id, instagram_business_account: account }
}

// A Page that links no account: Meta leaves the field out
function pageWithoutAccount(): Record<string, unknown> {
  return { id: PAGE }
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
// Facebook's host, only the routes of the Page token, only field names of the reference, and the
// token of the pair. Whatever else is asked is recorded in `rejected` and answered with an error.
// `me` answers as the Page `options.me` says.
function strictGraph(options: { token: string; me?: Record<string, unknown> }): {
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
  const me = options.me ?? page()
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
    // The token travels in the header, never in the URL
    if (url.searchParams.has('access_token')) return Promise.resolve(refuse())
    const bearer = new Headers(init?.headers).get('authorization')
    if (bearer !== `Bearer ${options.token}`) return Promise.resolve(graphError(401, 190))
    const route = url.pathname.replace(/^\/v\d+\.\d+\//, '')

    if (method === 'GET' && route === 'me') {
      if (url.searchParams.get('fields') !== 'id,instagram_business_account{id,username}') {
        return Promise.resolve(refuse())
      }
      calls.push(line)
      return Promise.resolve(json(200, me))
    }
    if (method === 'POST' && route === 'me/subscribed_apps') {
      const fields = (url.searchParams.get('subscribed_fields') ?? '').split(',')
      if (fields.some(field => !VALID_FIELDS.has(field))) return Promise.resolve(refuse())
      calls.push(line)
      return Promise.resolve(json(200, { success: true }))
    }
    if (method === 'POST' && route === 'me/messages') {
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
      get.mockResolvedValue(page())
      post.mockImplementation(request => {
        const unknown = (request.query?.subscribed_fields ?? '')
          .split(',')
          .filter(name => !(MetaSubscribableFields.INSTAGRAM as readonly string[]).includes(name))
        return unknown.length === 0
          ? Promise.resolve({ success: true })
          : Promise.reject(new Error(`Param subscribed_fields must be valid: ${unknown.join()}`))
      })

      await expect(plugin.connect({ storeId: 's', credentials })).resolves.toMatchObject({
        connectionId: ACCOUNT
      })
    })

    it('subscribes to exactly the fields the Messenger Platform setup documents, and not to message_edit', () => {
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
      get.mockResolvedValue(page())
      post.mockResolvedValue({ success: true })

      const result = await plugin.connect({
        storeId: 's',
        credentials: { accessToken: '  PAGE-token\n' }
      })

      expect(get.mock.calls[0]?.[0]).toMatchObject({ token: 'PAGE-token' })
      expect(result.credentials).toEqual({ accessToken: 'PAGE-token' })
    })

    it('names the check that refused when the subscription is not confirmed', async () => {
      const { plugin, get, post } = build()
      get.mockResolvedValue(page())
      post.mockResolvedValue({ success: false })

      await expect(plugin.connect({ storeId: 's', credentials })).rejects.toMatchObject({
        code: ErrorCodes.CHANNEL_CREDENTIALS_INVALID,
        failedCheck: PluginChecks.SUBSCRIPTION_NOT_CONFIRMED
      })
    })

    it('names the check that refused when the credentials have no token', async () => {
      const { plugin } = build()

      await expect(
        plugin.connect({ storeId: 's', credentials: { accessToken: '   ' } })
      ).rejects.toMatchObject({ failedCheck: PluginChecks.CREDENTIALS_SHAPE })
    })

    it('reads the Page and its account with the token, and subscribes the app on `me`', async () => {
      const { plugin, get, post } = build()
      get.mockResolvedValue(page())
      post.mockResolvedValue({ success: true })

      const result = await plugin.connect({ storeId: 's', credentials })

      // `me` is the Page of the token; the account is the field below it
      expect(get.mock.calls[0]?.[0]).toMatchObject({
        origin: MetaGraph.ORIGIN,
        path: ['me'],
        token: 'PAGE-token',
        query: { fields: 'id,instagram_business_account{id,username}' }
      })
      expect(post.mock.calls[0]?.[0]).toMatchObject({
        origin: MetaGraph.ORIGIN,
        path: ['me', 'subscribed_apps'],
        query: { subscribed_fields: 'messages,message_reactions,messaging_referral' },
        idempotent: true
      })
      // The connection is the account (entry.id of the webhooks); the Page is kept beside it
      expect(result).toEqual({
        connectionId: ACCOUNT,
        displayName: 'tienda',
        credentials,
        metadata: { pageId: PAGE }
      })
    })

    it.each([
      ['a Page that links no account', pageWithoutAccount(), PluginChecks.ACCOUNT_NOT_FOUND],
      ['an account that is null', page(null), PluginChecks.ACCOUNT_NOT_FOUND],
      [
        'an account that is an id and nothing else',
        page({ id: ACCOUNT }),
        PluginChecks.ACCOUNT_SHAPE_INVALID
      ],
      [
        'a list of accounts, which a Page does not answer with',
        page([
          { id: '1', username: 'a' },
          { id: '2', username: 'b' }
        ]),
        PluginChecks.ACCOUNT_SHAPE_INVALID
      ],
      [
        'an account whose id is a number: 17 digits do not fit one exactly',
        page({ id: Number(ACCOUNT), username: 'tienda' }),
        PluginChecks.ACCOUNT_SHAPE_INVALID
      ],
      [
        'an account id that is not digits',
        page({ id: '../x', username: 'tienda' }),
        PluginChecks.ACCOUNT_ID_NOT_NUMERIC
      ],
      [
        'a Page id that is not digits',
        page({ id: ACCOUNT, username: 'tienda' }, '../x'),
        PluginChecks.PAGE_ID_NOT_NUMERIC
      ],
      [
        'a Page id that is not digits, whatever the account looks like',
        page({ id: '1' }, '../x'),
        PluginChecks.PAGE_ID_NOT_NUMERIC
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

    it('treats an answer that is not a Page, as an unexpected answer, through the real client', async () => {
      const fetchMock = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          new Response('{"data":[]}', { headers: { 'content-type': 'application/json' } })
        )
      const real = buildReal()

      await expect(real.connect({ storeId: 's', credentials })).rejects.toMatchObject({
        code: ErrorCodes.CHANNEL_MESSAGE_FAILED
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      fetchMock.mockRestore()
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
    it('reports a healthy connection when the token is still of the same Page and account', async () => {
      const { plugin, get } = build()
      get.mockResolvedValue(page())
      await expect(plugin.healthCheck(ctx)).resolves.toMatchObject({ healthy: true })
    })

    it('does not call healthy a token of another Page that links the same account', async () => {
      const { plugin, get } = build()
      get.mockResolvedValue(page({ id: ACCOUNT, username: 'tienda' }, '110000000000002'))
      await expect(plugin.healthCheck(ctx)).rejects.toMatchObject({
        code: ErrorCodes.CHANNEL_CREDENTIALS_INVALID,
        retryable: false,
        failedCheck: PluginChecks.PAGE_ID_MISMATCH
      })
    })

    it('does not call healthy a token of the same Page that now links another account', async () => {
      const { plugin, get } = build()
      get.mockResolvedValue(page({ id: '17841400000000999', username: 'otra' }))
      await expect(plugin.healthCheck(ctx)).rejects.toMatchObject({
        code: ErrorCodes.CHANNEL_CREDENTIALS_INVALID,
        failedCheck: PluginChecks.ACCOUNT_ID_MISMATCH
      })
    })

    it('does not call healthy a connection that has no Page on record', async () => {
      const { plugin, get } = build()
      get.mockResolvedValue(page())
      await expect(plugin.healthCheck({ ...ctx, metadata: {} })).rejects.toMatchObject({
        failedCheck: PluginChecks.PAGE_ID_MISMATCH
      })
    })

    it('says so when the Page no longer links an account', async () => {
      const { plugin, get } = build()
      get.mockResolvedValue(pageWithoutAccount())
      await expect(plugin.healthCheck(ctx)).rejects.toMatchObject({
        failedCheck: PluginChecks.ACCOUNT_NOT_FOUND
      })
    })

    it('tells a revoked token to reconnect (error 190), through the real client and a strict Graph', async () => {
      const graph = strictGraph({ token: 'PAGE-ok' })
      const real = buildReal()

      await expect(
        real.healthCheck({ ...ctx, credentials: { accessToken: 'PAGE-revoked' } })
      ).rejects.toMatchObject({
        code: ErrorCodes.CHANNEL_CREDENTIALS_INVALID,
        retryable: false,
        providerCode: 190
      })
      // The call was made, to Facebook's host and the route of the Page, and Meta refused the token
      expect(graph.requests).toEqual([
        'GET https://graph.facebook.com/v23.0/me?fields=id%2Cinstagram_business_account%7Bid%2Cusername%7D'
      ])
      expect(graph.rejected).toEqual([])
      graph.restore()
    })

    it('reports healthy through the real client and a strict Graph', async () => {
      const graph = strictGraph({ token: 'PAGE-ok' })

      await expect(
        buildReal().healthCheck({ ...ctx, credentials: { accessToken: 'PAGE-ok' } })
      ).resolves.toMatchObject({ healthy: true })
      expect(graph.rejected).toEqual([])
      expect(graph.requests).toHaveLength(1)
      graph.restore()
    })

    it('refuses, through the real client, a token of another Page', async () => {
      const graph = strictGraph({
        token: 'PAGE-ok',
        me: page({ id: ACCOUNT, username: 'tienda' }, '110000000000002')
      })

      await expect(
        buildReal().healthCheck({ ...ctx, credentials: { accessToken: 'PAGE-ok' } })
      ).rejects.toMatchObject({ failedCheck: PluginChecks.PAGE_ID_MISMATCH })
      graph.restore()
    })
  })

  describe('against a strict Graph', () => {
    // VALID_FIELDS is `MetaSubscribableFields.INSTAGRAM`; the routes are the ones of the Page token
    // (get-started steps 2 to 5, webhooks/setup).
    // The fake answers like Meta: a wrong host, a wrong route or a field that does not exist is an
    // error, never a success, so a name that is wrong cannot pass the test
    it('connects with the routes, host and field names of the Page token', async () => {
      const graph = strictGraph({ token: 'PAGE-ok' })
      const real = buildReal()

      await expect(
        real.connect({ storeId: 's', credentials: { accessToken: 'PAGE-ok' } })
      ).resolves.toMatchObject({
        connectionId: ACCOUNT,
        displayName: 'tienda',
        metadata: { pageId: PAGE }
      })
      expect(graph.rejected).toEqual([])
      expect(graph.calls).toEqual([
        'GET https://graph.facebook.com/v23.0/me?fields=id%2Cinstagram_business_account%7Bid%2Cusername%7D',
        'POST https://graph.facebook.com/v23.0/me/subscribed_apps?subscribed_fields=messages%2Cmessage_reactions%2Cmessaging_referral'
      ])
      graph.restore()
    })

    it('refuses, through the real client, a Page with no account, and subscribes nothing', async () => {
      const graph = strictGraph({ token: 'PAGE-ok', me: pageWithoutAccount() })

      await expect(
        buildReal().connect({ storeId: 's', credentials: { accessToken: 'PAGE-ok' } })
      ).rejects.toMatchObject({ failedCheck: PluginChecks.ACCOUNT_NOT_FOUND })
      expect(graph.calls).toHaveLength(1)
      graph.restore()
    })

    it('never puts the token in a URL, in an error or in what it keeps', async () => {
      const graph = strictGraph({ token: 'PAGE-ok' })
      const real = buildReal()

      const connected = await real.connect({
        storeId: 's',
        credentials: { accessToken: 'PAGE-ok' }
      })
      expect(JSON.stringify(graph.requests)).not.toContain('PAGE-ok')
      expect(JSON.stringify(connected.metadata)).not.toContain('PAGE-ok')
      graph.restore()

      const refused = strictGraph({ token: 'PAGE-ok' })
      const failure = await real
        .connect({ storeId: 's', credentials: { accessToken: 'PAGE-secret-wrong' } })
        .catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(PluginError)
      expect(String(failure)).not.toContain('PAGE-secret-wrong')
      expect(JSON.stringify(failure)).not.toContain('PAGE-secret-wrong')
      expect(JSON.stringify(refused.requests)).not.toContain('PAGE-secret-wrong')
      refused.restore()
    })

    it('sends a text on `me/messages`, with the customer in the body', async () => {
      const graph = strictGraph({ token: 'PAGE-ok' })
      const real = buildReal()

      await real.sendMessage(
        { ...ctx, credentials: { accessToken: 'PAGE-ok' } },
        { channelIdentity: '5551234', content: 'Hola', ...key }
      )

      expect(graph.rejected).toEqual([])
      expect(graph.calls).toEqual(['POST https://graph.facebook.com/v23.0/me/messages'])
      expect(graph.bodies).toEqual([{ recipient: { id: '5551234' }, message: { text: 'Hola' } }])
      graph.restore()
    })

    it.each([
      ['the host of the old login', 'POST', 'https://graph.instagram.com/v23.0/me/subscribed_apps'],
      [
        'the edge of the unified login',
        'GET',
        'https://graph.facebook.com/v23.0/me/assigned_instagram_accounts'
      ],
      ['the Page without the fields', 'GET', 'https://graph.facebook.com/v23.0/me'],
      ['a send by the account id', 'POST', `https://graph.facebook.com/v23.0/${ACCOUNT}/messages`],
      ['a send with no recipient', 'POST', 'https://graph.facebook.com/v23.0/me/messages']
    ])('is refused by the fake itself: %s', async (_name, method, url) => {
      const graph = strictGraph({ token: 'PAGE-ok' })
      const response = await fetch(url, {
        method,
        headers: { authorization: 'Bearer PAGE-ok' },
        ...(method === 'POST' ? { body: '{}' } : {})
      })
      expect(response.status).toBe(400)
      expect(graph.rejected).toHaveLength(1)
      graph.restore()
    })

    it('would be told by the fake, and so by the test, of a name Meta does not know', async () => {
      const graph = strictGraph({ token: 'PAGE-ok' })
      const response = await fetch(
        'https://graph.facebook.com/v23.0/me/subscribed_apps?subscribed_fields=messages,messaging_referrals',
        { method: 'POST', headers: { authorization: 'Bearer PAGE-ok' } }
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
        token: 'PAGE-token',
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
        path: ['me', 'messages'],
        token: 'PAGE-token',
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
        path: ['me', 'messages'],
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
        path: ['me', 'messages'],
        idempotent: true,
        body: { recipient: { id: '99' }, sender_action: 'typing_on' }
      })
      expect(post.mock.calls[1]?.[0]).toMatchObject({
        origin: MetaGraph.ORIGIN,
        path: ['me', 'messages'],
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
