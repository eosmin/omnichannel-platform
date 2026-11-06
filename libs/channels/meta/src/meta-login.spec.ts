import { ChannelIds, MetaOAuth } from '@platform/core/domain'
import { ChannelConnectFailureReasons, PluginChecks } from '@platform/core/errors'
import { PluginError } from '@platform/plugins/sdk'

import { MetaGraphClient } from './meta-graph.client'
import { MetaLogin } from './meta-login'

const USER_TOKEN = 'USER-token-value'
const SHORT = 'SHORT-token-value'
const LONG = 'LONG-token-value'
const CODE = 'the-code-from-the-dialog'
const REDIRECT = 'https://api.example.com/api/v1/channels/oauth/callback'
const STATE = 'state-of-256-bits'
const PAGE = '110000000000001'
const OTHER_PAGE = '110000000000002'
const ACCOUNT = '17841400000000001'
const BUSINESS_A = '210000000000001'
const BUSINESS_B = '210000000000002'

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const graphError = (status: number, code: number): Response =>
  json(status, { error: { code, type: 'OAuthException', message: 'SECRET-text-of-meta' } })

type Handler = (url: URL, init: RequestInit) => Response
interface FakeGraph {
  requests: { method: string; url: URL; init: RequestInit }[]
  rejected: string[]
  restore: () => void
}

// A Graph as strict as the real one for what the login calls: Facebook's host only, a route that was
// declared, the token of the pair in the header and never in the address, and nothing else. Whatever is
// not declared is recorded in `rejected` and answered with an error, so a test ends by asserting it is empty.
function strictGraph(routes: Record<string, Handler>): FakeGraph {
  const requests: FakeGraph['requests'] = []
  const rejected: string[] = []
  const spy = jest.spyOn(globalThis, 'fetch').mockImplementation((input, init = {}) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    )
    const method = init.method ?? 'GET'
    requests.push({ method, url, init })
    const key = `${method} ${url.pathname.replace(/^\/v\d+\.\d+\//, '')}`
    const handler = routes[key]
    if (url.origin !== 'https://graph.facebook.com' || handler === undefined) {
      rejected.push(`${method} ${url.origin}${url.pathname}`)
      return Promise.resolve(graphError(400, 100))
    }
    // No secret or token ever rides in the address
    for (const name of ['access_token', 'client_secret', 'fb_exchange_token', 'code']) {
      if (url.searchParams.has(name)) {
        rejected.push(`${key} has ${name} in the address`)
        return Promise.resolve(graphError(400, 100))
      }
    }
    return Promise.resolve(handler(url, init))
  })
  return { requests, rejected, restore: () => spy.mockRestore() }
}

const bearer = (init: RequestInit): string | null => new Headers(init.headers).get('authorization')
const asUser = (answer: unknown): Handler => {
  return (_url, init) =>
    bearer(init) === `Bearer ${USER_TOKEN}` ? json(200, answer) : graphError(401, 190)
}

function login(pluginId: string = ChannelIds.INSTAGRAM, appId: string | null = '950161111253304') {
  const client = new MetaGraphClient({
    appSecret: 'the-app-secret-of-32-characters!!',
    appId: appId ?? undefined,
    verifyToken: 'v',
    graphVersion: 'v23.0'
  })
  return new MetaLogin(pluginId, client)
}

async function failure(run: () => Promise<unknown>): Promise<PluginError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof PluginError) return error
    throw error
  }
  throw new Error('it did not fail')
}

let graph: FakeGraph | undefined
afterEach(() => {
  expect(graph?.rejected ?? []).toEqual([])
  graph?.restore()
  graph = undefined
})

describe('MetaLogin', () => {
  describe('authorizationUrl', () => {
    it('is the dialog of the app, with the scopes of the channel and the code flow', () => {
      const url = new URL(login().authorizationUrl({ state: STATE, redirectUri: REDIRECT }))
      expect(`${url.origin}${url.pathname}`).toBe('https://www.facebook.com/v23.0/dialog/oauth')
      expect([...url.searchParams.keys()].sort()).toEqual(
        ['client_id', 'redirect_uri', 'response_type', 'scope', 'state'].sort()
      )
      expect(url.searchParams.get('client_id')).toBe('950161111253304')
      expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT)
      expect(url.searchParams.get('state')).toBe(STATE)
      expect(url.searchParams.get('response_type')).toBe('code')
      expect(url.searchParams.get('scope')).toBe(
        'pages_show_list,pages_messaging,pages_manage_metadata,pages_read_engagement,business_management,instagram_basic,instagram_manage_messages'
      )
    })

    it('asks Messenger for no Instagram permission', () => {
      const url = new URL(
        login(ChannelIds.MESSENGER).authorizationUrl({ state: STATE, redirectUri: REDIRECT })
      )
      expect(url.searchParams.get('scope')).not.toContain('instagram')
    })

    it('carries no secret and keeps a state or a redirect that is odd as one value', () => {
      const odd = 'a&scope=ads_management#x'
      const url = new URL(login().authorizationUrl({ state: odd, redirectUri: REDIRECT }))
      expect(url.searchParams.get('state')).toBe(odd)
      expect(url.searchParams.getAll('scope')).toHaveLength(1)
      expect(url.href).not.toContain('app-secret')
    })

    it('fails when the app has no id, so no dialog is made for an app that is not set up', () => {
      expect(() =>
        login(ChannelIds.INSTAGRAM, null).authorizationUrl({
          state: STATE,
          redirectUri: REDIRECT
        })
      ).toThrow()
    })
  })

  describe('exchangeCode', () => {
    function exchangeRoutes(): Record<string, Handler> {
      return {
        'POST oauth/access_token': (_url, init) => {
          const body = new URLSearchParams(typeof init.body === 'string' ? init.body : '')
          // The secret and the app are proved in the body of a POST, with no token to send
          if (
            bearer(init) !== null ||
            body.get('client_secret') !== 'the-app-secret-of-32-characters!!'
          ) {
            return graphError(400, 100)
          }
          if (body.get('code') === CODE && body.get('redirect_uri') === REDIRECT) {
            return json(200, { access_token: SHORT, token_type: 'bearer' })
          }
          if (
            body.get('grant_type') === 'fb_exchange_token' &&
            body.get('fb_exchange_token') === SHORT
          ) {
            return json(200, { access_token: LONG, expires_in: 5184000 })
          }
          return graphError(400, 100)
        }
      }
    }

    it('trades the code for a short token and that one for a long-lived token', async () => {
      graph = strictGraph(exchangeRoutes())
      await expect(login().exchangeCode({ code: CODE, redirectUri: REDIRECT })).resolves.toBe(LONG)
      expect(graph.requests.map(request => request.method)).toEqual(['POST', 'POST'])
      for (const { init, url } of graph.requests) {
        expect(new Headers(init.headers).get('content-type')).toBe(
          'application/x-www-form-urlencoded'
        )
        expect(url.search).toBe('')
      }
    })

    it('answers with a PluginError that holds nothing Meta said when the code is refused', async () => {
      graph = strictGraph({ 'POST oauth/access_token': () => graphError(400, 100) })
      const error = await failure(() =>
        login().exchangeCode({ code: 'used', redirectUri: REDIRECT })
      )
      expect(JSON.stringify(error)).not.toContain('SECRET-text-of-meta')
      expect(error.message).not.toContain('used')
      // A code is good once: a refusal is not tried again
      expect(graph.requests).toHaveLength(1)
    })

    it('does not try again a call that may have reached Meta', async () => {
      graph = strictGraph({
        'POST oauth/access_token': () => new Response('<html>', { status: 502 })
      })
      await failure(() => login().exchangeCode({ code: CODE, redirectUri: REDIRECT }))
      expect(graph.requests).toHaveLength(1)
    })

    it('does not tell the owner to wait when Meta refuses the app (a code Meta also uses for outages)', async () => {
      graph = strictGraph({ 'POST oauth/access_token': () => graphError(400, 1) })
      const error = await failure(() => login().exchangeCode({ code: CODE, redirectUri: REDIRECT }))
      expect(error.reason).toBe(ChannelConnectFailureReasons.REQUEST_REJECTED)
      expect(error.retryable).toBe(false)
    })

    it('still calls a Meta outage an outage', async () => {
      graph = strictGraph({ 'POST oauth/access_token': () => graphError(500, 2) })
      const error = await failure(() => login().exchangeCode({ code: CODE, redirectUri: REDIRECT }))
      expect(error.reason).toBe(ChannelConnectFailureReasons.PROVIDER_UNAVAILABLE)
    })

    it('refuses an answer with no token or one that is not an object', async () => {
      graph = strictGraph({ 'POST oauth/access_token': () => json(200, { token_type: 'bearer' }) })
      const error = await failure(() => login().exchangeCode({ code: CODE, redirectUri: REDIRECT }))
      expect(error.reason).toBe(ChannelConnectFailureReasons.PROVIDER_UNAVAILABLE)
      expect(error.outcomeUnknown).toBe(true)
    })

    it('does not call Meta when the app has no id', async () => {
      graph = strictGraph({})
      await failure(() =>
        login(ChannelIds.INSTAGRAM, null).exchangeCode({ code: CODE, redirectUri: REDIRECT })
      )
      expect(graph.requests).toHaveLength(0)
    })
  })

  describe('grantedScopes', () => {
    it('asks for the whole list, so a granted permission does not fall on a second page', async () => {
      graph = strictGraph({ 'GET me/permissions': asUser({ data: [] }) })
      await login().grantedScopes({ userToken: USER_TOKEN })
      expect(graph.requests[0]?.url.searchParams.get('limit')).toBe(MetaOAuth.LIST_LIMIT)
    })

    it('keeps the granted ones and drops the one the person cleared', async () => {
      graph = strictGraph({
        'GET me/permissions': asUser({
          data: [
            { permission: 'pages_show_list', status: 'granted' },
            { permission: 'pages_read_engagement', status: 'declined' }
          ]
        })
      })
      await expect(login().grantedScopes({ userToken: USER_TOKEN })).resolves.toEqual([
        'pages_show_list'
      ])
    })
  })

  describe('listAssets', () => {
    const pageA = {
      id: PAGE,
      name: 'Smart Gadget',
      instagram_business_account: { id: ACCOUNT, username: 'smartgadgetsv_' }
    }
    const pageB = { id: OTHER_PAGE, name: 'Other' }

    it('finds a Page that lives in a portfolio when me/accounts is empty, in all the portfolios', async () => {
      graph = strictGraph({
        'GET me/accounts': asUser({ data: [] }),
        'GET me/businesses': asUser({ data: [{ id: BUSINESS_A }, { id: BUSINESS_B }] }),
        [`GET ${BUSINESS_A}/owned_pages`]: asUser({ data: [pageB] }),
        [`GET ${BUSINESS_B}/owned_pages`]: asUser({ data: [pageA] })
      })
      const assets = await login().listAssets({ userToken: USER_TOKEN })
      expect(assets).toEqual([
        { id: OTHER_PAGE, name: 'Other', linkedAccount: null },
        {
          id: PAGE,
          name: 'Smart Gadget',
          linkedAccount: { id: ACCOUNT, username: 'smartgadgetsv_' }
        }
      ])
    })

    it('lists a Page once when two ways find it', async () => {
      graph = strictGraph({
        'GET me/accounts': asUser({ data: [pageA] }),
        'GET me/businesses': asUser({ data: [{ id: BUSINESS_A }] }),
        [`GET ${BUSINESS_A}/owned_pages`]: asUser({ data: [pageA, pageB] })
      })
      const assets = await login().listAssets({ userToken: USER_TOKEN })
      expect(assets.map(asset => asset.id)).toEqual([PAGE, OTHER_PAGE])
    })

    it('never asks for the token of a Page while it lists, and bounds each list', async () => {
      graph = strictGraph({
        'GET me/accounts': asUser({ data: [pageA] }),
        'GET me/businesses': asUser({ data: [{ id: BUSINESS_A }] }),
        [`GET ${BUSINESS_A}/owned_pages`]: asUser({ data: [] })
      })
      await login().listAssets({ userToken: USER_TOKEN })
      for (const { url } of graph.requests) {
        expect(url.searchParams.get('fields') ?? '').not.toContain('access_token')
        expect(url.searchParams.get('limit')).toBe(MetaOAuth.LIST_LIMIT)
      }
    })

    it('is empty, not an error, when the person has no Page: the screen asks for its number', async () => {
      graph = strictGraph({
        'GET me/accounts': asUser({ data: [] }),
        'GET me/businesses': asUser({ data: [] })
      })
      await expect(login().listAssets({ userToken: USER_TOKEN })).resolves.toEqual([])
    })

    it('fails, and does not say there is nothing to connect, when the portfolios could not be read', async () => {
      graph = strictGraph({
        'GET me/accounts': asUser({ data: [] }),
        'GET me/businesses': () => graphError(500, 2)
      })
      const error = await failure(() => login().listAssets({ userToken: USER_TOKEN }))
      expect(error.reason).toBe(ChannelConnectFailureReasons.PROVIDER_UNAVAILABLE)
    })

    it('fails when a portfolio could not be read and nothing else was found', async () => {
      graph = strictGraph({
        'GET me/accounts': asUser({ data: [] }),
        'GET me/businesses': asUser({ data: [{ id: BUSINESS_A }] }),
        [`GET ${BUSINESS_A}/owned_pages`]: () => graphError(429, 4)
      })
      const error = await failure(() => login().listAssets({ userToken: USER_TOKEN }))
      expect(error.reason).toBe(ChannelConnectFailureReasons.PROVIDER_BUSY)
    })

    it('asks Messenger for no Instagram field, which would need a permission it never asks for', async () => {
      graph = strictGraph({
        'GET me/accounts': asUser({ data: [pageB] }),
        'GET me/businesses': asUser({ data: [] })
      })
      await login(ChannelIds.MESSENGER).listAssets({ userToken: USER_TOKEN })
      const fields = graph.requests
        .map(request => request.url.searchParams.get('fields') ?? '')
        .filter(value => value.includes('name'))
      expect(fields.length).toBeGreaterThan(0)
      for (const value of fields) expect(value).not.toContain('instagram')
    })

    it('keeps the entry that says which account a Page links when another way found it thinner', async () => {
      graph = strictGraph({
        'GET me/accounts': asUser({ data: [{ id: PAGE, name: 'Smart Gadget' }] }),
        'GET me/businesses': asUser({ data: [{ id: BUSINESS_A }] }),
        [`GET ${BUSINESS_A}/owned_pages`]: asUser({ data: [pageA] })
      })
      const assets = await login().listAssets({ userToken: USER_TOKEN })
      expect(assets).toHaveLength(1)
      expect(assets[0]?.linkedAccount).toEqual({ id: ACCOUNT, username: 'smartgadgetsv_' })
    })

    it('keeps what one way found when the other fails', async () => {
      graph = strictGraph({
        'GET me/accounts': () => graphError(400, 10),
        'GET me/businesses': asUser({ data: [{ id: BUSINESS_A }] }),
        [`GET ${BUSINESS_A}/owned_pages`]: asUser({ data: [pageA] })
      })
      const assets = await login().listAssets({ userToken: USER_TOKEN })
      expect(assets.map(asset => asset.id)).toEqual([PAGE])
    })

    it('fails when every way failed, because an outage is not an empty list', async () => {
      graph = strictGraph({
        'GET me/accounts': () => graphError(500, 2),
        'GET me/businesses': () => graphError(500, 2)
      })
      const error = await failure(() => login().listAssets({ userToken: USER_TOKEN }))
      expect(error.reason).toBe(ChannelConnectFailureReasons.PROVIDER_UNAVAILABLE)
    })

    it('stops at a token Meta no longer accepts, before it asks about any portfolio', async () => {
      // The two lists are asked together, and both answer that the token is dead
      graph = strictGraph({
        'GET me/accounts': () => graphError(401, 190),
        'GET me/businesses': () => graphError(401, 190)
      })
      const error = await failure(() => login().listAssets({ userToken: USER_TOKEN }))
      expect(error.reason).toBe(ChannelConnectFailureReasons.TOKEN_REJECTED)
      expect(graph.requests.every(request => !request.url.pathname.endsWith('/owned_pages'))).toBe(
        true
      )
    })

    it('asks about at most the portfolios it is allowed to', async () => {
      const many = Array.from({ length: 30 }, (_value, index) => ({
        id: String(300000000000000 + index)
      }))
      const routes: Record<string, Handler> = {
        'GET me/accounts': asUser({ data: [] }),
        'GET me/businesses': asUser({ data: many })
      }
      for (const business of many) routes[`GET ${business.id}/owned_pages`] = asUser({ data: [] })
      graph = strictGraph(routes)
      await login().listAssets({ userToken: USER_TOKEN })
      const owned = graph.requests.filter(request => request.url.pathname.endsWith('/owned_pages'))
      expect(owned).toHaveLength(MetaOAuth.MAX_BUSINESSES)
    })

    it('refuses a Page whose id is not a number, and nothing else is the cause', async () => {
      graph = strictGraph({
        'GET me/accounts': asUser({ data: [{ id: '../me', name: 'x' }] }),
        // The portfolios answer well and empty, so the id is the only thing wrong
        'GET me/businesses': asUser({ data: [] })
      })
      const error = await failure(() => login().listAssets({ userToken: USER_TOKEN }))
      expect(error.reason).toBe(ChannelConnectFailureReasons.PROVIDER_ANSWER_UNEXPECTED)
    })

    it('names a Page with no name by its id, and cuts a long name', async () => {
      graph = strictGraph({
        'GET me/accounts': asUser({
          data: [{ id: PAGE }, { id: OTHER_PAGE, name: 'n'.repeat(500) }]
        }),
        'GET me/businesses': asUser({ data: [] })
      })
      const assets = await login().listAssets({ userToken: USER_TOKEN })
      expect(assets[0]?.name).toBe(PAGE)
      expect(assets[1]?.name).toHaveLength(MetaOAuth.ASSET_NAME_MAX_LENGTH)
    })
  })

  describe('credentialsFor', () => {
    const route = (answer: unknown, fields: string): Record<string, Handler> => ({
      [`GET ${PAGE}`]: (url, init) =>
        url.searchParams.get('fields') !== fields ? graphError(400, 100) : asUser(answer)(url, init)
    })

    it('gives the token of the Page, which is what a connection keeps', async () => {
      graph = strictGraph(
        route(
          { id: PAGE, access_token: 'PAGE-token', instagram_business_account: { id: ACCOUNT } },
          'id,access_token,instagram_business_account{id}'
        )
      )
      await expect(
        login().credentialsFor({ userToken: USER_TOKEN, assetId: PAGE })
      ).resolves.toEqual({ accessToken: 'PAGE-token' })
    })

    it('does not ask Messenger about Instagram', async () => {
      graph = strictGraph(route({ id: PAGE, access_token: 'PAGE-token' }, 'id,access_token'))
      await expect(
        login(ChannelIds.MESSENGER).credentialsFor({ userToken: USER_TOKEN, assetId: PAGE })
      ).resolves.toEqual({ accessToken: 'PAGE-token' })
    })

    it('says a Page has no Instagram account, for the channel that needs one', async () => {
      graph = strictGraph(
        route(
          { id: PAGE, access_token: 'PAGE-token' },
          'id,access_token,instagram_business_account{id}'
        )
      )
      const error = await failure(() =>
        login().credentialsFor({ userToken: USER_TOKEN, assetId: PAGE })
      )
      expect(error.reason).toBe(ChannelConnectFailureReasons.PAGE_WITHOUT_INSTAGRAM)
    })

    it('says the person lacks the task that gives a token, when Meta leaves it out', async () => {
      graph = strictGraph(route({ id: PAGE }, 'id,access_token'))
      const error = await failure(() =>
        login(ChannelIds.MESSENGER).credentialsFor({ userToken: USER_TOKEN, assetId: PAGE })
      )
      expect(error.reason).toBe(ChannelConnectFailureReasons.PERMISSION_MISSING)
    })

    it('says no Page when the id is one the person cannot reach (Meta answers 100)', async () => {
      graph = strictGraph({ [`GET ${PAGE}`]: () => graphError(400, 100) })
      const error = await failure(() =>
        login(ChannelIds.MESSENGER).credentialsFor({ userToken: USER_TOKEN, assetId: PAGE })
      )
      expect(error.reason).toBe(ChannelConnectFailureReasons.NO_ASSETS)
      expect(JSON.stringify(error)).not.toContain('SECRET-text-of-meta')
    })

    it.each([10, 200, 210])(
      'keeps the reason a permission error already has (code %i), and does not ask for another number',
      async code => {
        graph = strictGraph({ [`GET ${PAGE}`]: () => graphError(403, code) })
        const error = await failure(() =>
          login(ChannelIds.MESSENGER).credentialsFor({ userToken: USER_TOKEN, assetId: PAGE })
        )
        expect(error.reason).toBe(ChannelConnectFailureReasons.PERMISSION_MISSING)
      }
    )

    it('refuses an answer that is another Page than the one asked for', async () => {
      graph = strictGraph(route({ id: OTHER_PAGE, access_token: 'PAGE-token' }, 'id,access_token'))
      const error = await failure(() =>
        login(ChannelIds.MESSENGER).credentialsFor({ userToken: USER_TOKEN, assetId: PAGE })
      )
      expect(error.failedCheck).toBe(PluginChecks.PAGE_ID_MISMATCH)
    })

    it.each(['', '12ab', '../me', '1 2', '1/2', 'me'])(
      'refuses the id %j before it reaches a path',
      async value => {
        graph = strictGraph({})
        const error = await failure(() =>
          login().credentialsFor({ userToken: USER_TOKEN, assetId: value })
        )
        expect(error.failedCheck).toBe(PluginChecks.PAGE_ID_NOT_NUMERIC)
        expect(graph.requests).toHaveLength(0)
      }
    )

    it('stops at a token Meta no longer accepts', async () => {
      graph = strictGraph({ [`GET ${PAGE}`]: () => graphError(401, 190) })
      const error = await failure(() =>
        login().credentialsFor({ userToken: USER_TOKEN, assetId: PAGE })
      )
      expect(error.reason).toBe(ChannelConnectFailureReasons.TOKEN_REJECTED)
    })
  })

  describe('as the oauth of a plugin', () => {
    it('declares the scopes of its channel and a kind the core knows', () => {
      expect(login(ChannelIds.INSTAGRAM).scopes).toHaveLength(7)
      expect(login(ChannelIds.MESSENGER).scopes).toHaveLength(5)
      expect(login().kind).toBe('meta-facebook-login')
    })
  })
})
