import { InstagramPlugin } from '@platform/channels/instagram'
import { MessengerPlugin } from '@platform/channels/messenger'
import { MetaGraphClient } from '@platform/channels/meta'
import { InstagramApi, MessengerApi, MetaSubscribableFields } from '@platform/core/domain'
import { PluginChecks } from '@platform/core/errors'
import type { ChannelPlugin } from '@platform/plugins/sdk'

// Messenger and Instagram share a Page and one app: the fields that app has on the Page are one list,
// and each connection has to add its fields to it, never take the other's away. Meta does not say whether
// a POST to `subscribed_apps` replaces the list or adds to it, so each case runs against a Graph that does
// either.

const PAGE = '1327188517412913'
const ACCOUNT = '17841448243146605'
const APP = '1804256354142951'
const TOKEN = 'PAGE-token-of-the-contract'
const OTHER_APP = '1111111111111111'

type Semantics = 'replace' | 'add'

interface World {
  fields: Set<string>
  otherAppFields: Set<string>
  posts: string[]
  requests: string[]
  // What the fake does when asked: for the failure cases
  readStatus: number
  appStatus: number
  readBody: unknown
  appBody: unknown
}

// The Page edge is what both channels reach: its enum is the one that accepts or refuses a name
const VALID = new Set<string>(MetaSubscribableFields.PAGE)

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
const graphError = (status: number): Response =>
  json(status, { error: { code: status === 401 ? 190 : 1, type: 'OAuthException', message: 'x' } })

// A Graph with the one Page of the owner: its identity routes, the app of the token and the list of apps
// subscribed to it, which is the state under test
function graph(
  semantics: Semantics,
  initial: string[] = []
): { world: World; restore: () => void } {
  const world: World = {
    fields: new Set(initial),
    otherAppFields: new Set(['feed', 'leadgen']),
    posts: [],
    requests: [],
    readStatus: 200,
    appStatus: 200,
    readBody: undefined,
    appBody: undefined
  }
  const spy = jest.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    )
    const method = init?.method ?? 'GET'
    world.requests.push(`${method} ${url.pathname}${url.search}`)
    if (new Headers(init?.headers).get('authorization') !== `Bearer ${TOKEN}`) {
      return Promise.resolve(graphError(401))
    }
    if (url.searchParams.has('access_token')) return Promise.resolve(graphError(400))
    const route = url.pathname.replace(/^\/v\d+\.\d+\//, '')
    const fieldsQuery = url.searchParams.get('fields')

    if (method === 'GET' && route === 'me') {
      if (fieldsQuery === 'id') return Promise.resolve(json(200, { id: PAGE }))
      if (fieldsQuery === 'id,name')
        return Promise.resolve(json(200, { id: PAGE, name: 'Smart Gadget Sv' }))
      if (fieldsQuery === InstagramApi.PAGE_ACCOUNT_FIELDS) {
        return Promise.resolve(
          json(200, {
            id: PAGE,
            instagram_business_account: { id: ACCOUNT, username: 'smartgadgetsv_' }
          })
        )
      }
      return Promise.resolve(graphError(400))
    }
    if (method === 'GET' && route === 'app') {
      if (world.appStatus !== 200) return Promise.resolve(graphError(world.appStatus))
      if (world.appBody !== undefined) return Promise.resolve(json(200, world.appBody))
      return Promise.resolve(json(200, { id: APP }))
    }
    if (route === `${PAGE}/subscribed_apps` || route === 'me/subscribed_apps') {
      if (method === 'GET') {
        if (world.readStatus !== 200) return Promise.resolve(graphError(world.readStatus))
        if (world.readBody !== undefined) return Promise.resolve(json(200, world.readBody))
        const data: unknown[] = [
          {
            link: 'https://example.test/other',
            name: 'other',
            id: OTHER_APP,
            subscribed_fields: [...world.otherAppFields]
          }
        ]
        if (world.fields.size > 0) {
          data.push({
            link: `https://www.facebook.com/games/?app_id=${APP}`,
            name: 'omnichannel-dev',
            id: APP,
            subscribed_fields: [...world.fields]
          })
        }
        return Promise.resolve(json(200, { data }))
      }
      if (method === 'POST') {
        const sent = (url.searchParams.get('subscribed_fields') ?? '').split(',')
        if (sent.some(name => !VALID.has(name))) return Promise.resolve(graphError(400))
        world.posts.push(sent.join(','))
        if (semantics === 'replace') world.fields = new Set(sent)
        else sent.forEach(name => world.fields.add(name))
        return Promise.resolve(json(200, { success: true }))
      }
    }
    return Promise.resolve(graphError(400))
  })
  return { world, restore: () => spy.mockRestore() }
}

const client = (): MetaGraphClient =>
  new MetaGraphClient({ appSecret: 's', verifyToken: 'v', graphVersion: 'v23.0' })

const connect = (plugin: ChannelPlugin): Promise<unknown> =>
  plugin.connect({ storeId: 's', credentials: { accessToken: TOKEN } })

const MESSENGER_FIELDS = MessengerApi.SUBSCRIBED_FIELDS.split(',')
const INSTAGRAM_FIELDS = InstagramApi.SUBSCRIBED_FIELDS.split(',')

describe.each<Semantics>(['replace', 'add'])(
  'the subscription of a Page shared by Messenger and Instagram (Meta %s the list on a POST)',
  semantics => {
    afterEach(() => jest.restoreAllMocks())

    it('keeps the fields of Messenger when Instagram connects after it', async () => {
      const { world } = graph(semantics)
      await connect(new MessengerPlugin(client()))
      await connect(new InstagramPlugin(client()))
      expect(world.fields).toEqual(new Set([...MESSENGER_FIELDS, ...INSTAGRAM_FIELDS]))
    })

    it('keeps the fields of Instagram when Messenger connects after it', async () => {
      const { world } = graph(semantics)
      await connect(new InstagramPlugin(client()))
      await connect(new MessengerPlugin(client()))
      expect(world.fields).toEqual(new Set([...MESSENGER_FIELDS, ...INSTAGRAM_FIELDS]))
    })

    it('conserves what the Page already had, as the owner’s Page did', async () => {
      const { world } = graph(semantics, MESSENGER_FIELDS)
      await connect(new InstagramPlugin(client()))
      expect(world.fields).toEqual(new Set([...MESSENGER_FIELDS, ...INSTAGRAM_FIELDS]))
    })

    it('is the same on a reconnection: no field is lost or repeated', async () => {
      const { world } = graph(semantics)
      const instagram = new InstagramPlugin(client())
      await connect(new MessengerPlugin(client()))
      await connect(instagram)
      const first = [...world.fields]
      await connect(instagram)
      await connect(instagram)
      expect([...world.fields].sort()).toEqual([...first].sort())
      const last = world.posts[world.posts.length - 1] ?? ''
      expect(new Set(last.split(',')).size).toBe(last.split(',').length)
    })

    it('does not touch the fields of another app on the Page', async () => {
      const { world } = graph(semantics)
      await connect(new InstagramPlugin(client()))
      expect(world.posts.every(sent => !sent.includes('feed') && !sent.includes('leadgen'))).toBe(
        true
      )
    })
  }
)

describe('a connection whose subscription cannot be read', () => {
  afterEach(() => jest.restoreAllMocks())

  const channels: [string, () => ChannelPlugin][] = [
    ['Instagram', () => new InstagramPlugin(client())],
    ['Messenger', () => new MessengerPlugin(client())]
  ]

  describe.each(channels)('%s', (_channel, create) => {
    it.each([
      ['Meta answers an error to the read', 401 as const],
      ['Meta is down for the read', 500 as const]
    ])('subscribes nothing when %s, and says which check', async (_name, status) => {
      const { world } = graph('replace', MESSENGER_FIELDS)
      world.readStatus = status
      await expect(connect(create())).rejects.toMatchObject({
        failedCheck: PluginChecks.SUBSCRIPTION_READ_FAILED
      })
      expect(world.posts).toEqual([])
      expect(world.fields).toEqual(new Set(MESSENGER_FIELDS))
    })

    it.each([
      ['an app id that is not digits', { id: '../x' }],
      ['an answer without an id', {}]
    ])('subscribes nothing for %s from GET app', async (_name, body) => {
      const { world } = graph('replace', MESSENGER_FIELDS)
      world.appBody = body
      await expect(connect(create())).rejects.toMatchObject({
        retryable: false,
        failedCheck: PluginChecks.SUBSCRIPTION_APP_UNKNOWN
      })
      expect(world.posts).toEqual([])
    })

    it('subscribes nothing when our app is not in the part of the answer that was read', async () => {
      const { world } = graph('replace', MESSENGER_FIELDS)
      world.readBody = {
        data: [{ id: OTHER_APP, subscribed_fields: ['feed'] }],
        paging: { next: 'https://graph.facebook.com/next' }
      }
      await expect(connect(create())).rejects.toMatchObject({
        retryable: false,
        failedCheck: PluginChecks.SUBSCRIPTION_SHAPE_INVALID
      })
      expect(world.posts).toEqual([])
    })

    it('adds its fields on a Page where other apps are subscribed and ours is not yet', async () => {
      const { world } = graph('replace')
      await connect(create())
      expect(world.fields.size).toBeGreaterThan(0)
      expect(world.posts.every(sent => !sent.includes('feed') && !sent.includes('leadgen'))).toBe(
        true
      )
    })
  })

  it('keeps whether the failure may be tried again', async () => {
    const { world } = graph('replace')
    world.readStatus = 500
    await expect(connect(new InstagramPlugin(client()))).rejects.toMatchObject({ retryable: true })
  })

  it.each([
    ['no data', {}],
    ['data that is not a list', { data: 'x' }],
    [
      'our entry with fields that are not a list',
      { data: [{ id: APP, subscribed_fields: 'messages' }] }
    ]
  ])('subscribes nothing for an answer with %s', async (_name, body) => {
    const { world } = graph('replace', MESSENGER_FIELDS)
    world.readBody = body
    await expect(connect(new MessengerPlugin(client()))).rejects.toMatchObject({
      failedCheck: PluginChecks.SUBSCRIPTION_SHAPE_INVALID
    })
    expect(world.posts).toEqual([])
  })

  it('subscribes nothing when our entry has a field that cannot be sent back', async () => {
    const { world } = graph('replace', MESSENGER_FIELDS)
    world.readBody = { data: [{ id: APP, subscribed_fields: ['messages', '../x'] }] }
    await expect(connect(new InstagramPlugin(client()))).rejects.toMatchObject({
      failedCheck: PluginChecks.SUBSCRIPTION_SHAPE_INVALID
    })
    expect(world.posts).toEqual([])
  })

  it('subscribes nothing when the app of the token cannot be told', async () => {
    const { world } = graph('replace', MESSENGER_FIELDS)
    world.appStatus = 400
    await expect(connect(new InstagramPlugin(client()))).rejects.toMatchObject({
      failedCheck: PluginChecks.SUBSCRIPTION_APP_UNKNOWN
    })
    expect(world.posts).toEqual([])
  })

  it('never puts the token in a URL or in the error', async () => {
    const { world } = graph('replace')
    world.readStatus = 401
    const failure = await connect(new InstagramPlugin(client())).catch((error: unknown) => error)
    expect(JSON.stringify(failure)).not.toContain(TOKEN)
    expect(String(failure)).not.toContain(TOKEN)
    expect(JSON.stringify(world.requests)).not.toContain(TOKEN)
  })
})
