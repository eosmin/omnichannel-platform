import { randomInt, randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import type { Redis } from 'ioredis'

import { ChannelOAuthConfig } from '@platform/channels/connections'
import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { RoleNames } from '@platform/core/auth'
import { CacheKeys } from '@platform/core/cache'
import { CredentialCipher, hashToken } from '@platform/core/crypto'
import { ensureMembership, type OwnerClient } from '@platform/core/database-testing'
import {
  ChannelAuthMethods,
  ChannelConnectionStatus,
  ChannelOAuthLimits
} from '@platform/core/domain'
import { ChannelConnectFailureReasons, ErrorCodes } from '@platform/core/errors'
import { REDIS_CLIENT } from '@platform/core/redis'
import { PluginRegistry } from '@platform/plugins/runtime'
import { type ChannelOAuth, PluginError } from '@platform/plugins/sdk'

import { ChannelOAuthStore } from '../../apps/api/src/modules/channels/oauth/channel-oauth.store'
import { buildChannelPlugin, ensurePluginInstallation } from '../builders'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { createActor, seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { anonymousApi, api } from '../helpers/http'

const OK = 200
const CREATED = 201
const FOUND = 302
const NO_CONTENT = 204
const BAD_REQUEST = 400
const UNAUTHORIZED = 401
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409
const TOO_MANY = 429

const FRONTEND = 'https://app.example.com'
// The callback of this platform, as the registry of the app composed it from API_URL (set once the app is up)
let REDIRECT_URI = ''
const USER_TOKEN = 'USER-token-that-must-never-leave'
const PAGE_TOKEN_PREFIX = 'PAGE-token-'
const GOOD_CODE = 'good-code'

interface ErrorBody {
  error: { code: string; message?: string; metadata?: Record<string, unknown> }
}
interface SessionBody {
  pluginId: string
  connectionId: string | null
  repairAccountId: string | null
  assets: { id: string; name: string; linkedAccount: unknown }[]
}

describe('"Connect with Facebook": the login of a channel', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let registry: PluginRegistry
  let redis: Redis
  let otherAdminA: { id: string; email: string; token: string }
  let counter = 0
  const registered: string[] = []

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp([], builder =>
      builder.overrideProvider(ChannelOAuthConfig).useValue({ frontendUrl: FRONTEND })
    )
    ctx = await seedTestContext(owner, app, prefix)
    registry = app.get(PluginRegistry, { strict: false })
    REDIRECT_URI = registry.oauthCallbackUrl ?? ''
    redis = app.get<Redis>(REDIS_CLIENT, { strict: false })
    otherAdminA = await createActor(owner, app, {
      prefix,
      name: 'otherAdminA',
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      roleId: ctx.roleIds[RoleNames.ADMIN]
    })
  })
  afterAll(async () => {
    for (const id of registered) registry.unregister(id)
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const asOtherAdmin = () => api(app, otherAdminA, ctx.storeA)
  const asAgent = () => api(app, ctx.agentA, ctx.storeA)
  const asAdminB = () => api(app, ctx.adminB, ctx.storeB)
  const asAdminA2 = () => api(app, ctx.adminA2, ctx.storeA2)
  const codeOf = (body: unknown) => (body as ErrorBody).error.code

  // What a provider's login does in these tests: the code, the permissions and the Pages are what the case sets
  function login(over: Partial<ChannelOAuth> = {}) {
    const calls = {
      exchange: jest.fn(),
      granted: jest.fn(),
      list: jest.fn(),
      credentials: jest.fn()
    }
    const oauth: ChannelOAuth = {
      kind: 'meta-facebook-login',
      dialogOrigin: 'https://dialog.example',
      providerName: { es: 'Ejemplo', en: 'Example' },
      linkedAccount: null,
      assetIdPattern: '^\\d{1,32}$',
      scopes: ['pages_show_list', 'pages_messaging'],
      redirectUri: REDIRECT_URI,
      authorizationUrl: ({ state, redirectUri }) =>
        `https://dialog.example/oauth?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
      exchangeCode: ctxIn => {
        calls.exchange(ctxIn)
        return ctxIn.code === GOOD_CODE
          ? Promise.resolve(USER_TOKEN)
          : Promise.reject(
              new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, { retryable: false })
            )
      },
      grantedScopes: ctxIn => {
        calls.granted(ctxIn)
        return Promise.resolve(['pages_show_list', 'pages_messaging'])
      },
      listAssets: ctxIn => {
        calls.list(ctxIn)
        return Promise.resolve([{ id: '1100', name: 'Page A', linkedAccount: null }])
      },
      credentialsFor: ctxIn => {
        calls.credentials(ctxIn)
        return Promise.resolve({ token: `${PAGE_TOKEN_PREFIX}${ctxIn.assetId}` })
      },
      ...over
    }
    return { oauth, calls }
  }

  // A plugin of its own for each case, installed in the stores, with a login and the account it connects
  async function register(
    oauth: ChannelOAuth | undefined,
    connectionId = `acct-${randomUUID()}`,
    metadata: Record<string, unknown> = { region: 'sv' }
  ) {
    counter += 1
    const id = `oa_${counter}`
    registry.register(
      buildChannelPlugin({
        id,
        ...(oauth === undefined ? {} : { oauth }),
        connect: input =>
          Promise.resolve({
            connectionId,
            displayName: 'Acme page',
            credentials: input.credentials,
            metadata
          })
      })
    )
    registered.push(id)
    for (const store of [ctx.storeA, ctx.storeB]) {
      await ensurePluginInstallation(owner, { storeId: store.id, pluginId: id })
    }
    return { id, connectionId }
  }

  const stateOf = (authorizeUrl: string): string =>
    new URL(authorizeUrl).searchParams.get('state') ?? ''
  async function start(pluginId: string, agent = asAdmin): Promise<string> {
    const response = await agent().post(ApiRoutes.channels.oauthStart(pluginId))
    expect(response.status).toBe(OK)
    return stateOf((response.body as { authorizeUrl: string }).authorizeUrl)
  }
  // The browser coming back from the provider: no token, no store header
  const callback = (query: Record<string, string | string[]>) =>
    anonymousApi(app).get(ApiRoutes.channels.oauthCallback).query(query).redirects(0)
  const locationOf = (response: { headers: Record<string, unknown> }): URL =>
    new URL(String(response.headers['location']))
  async function sessionOf(pluginId: string, agent = asAdmin): Promise<string> {
    const state = await start(pluginId, agent)
    const response = await callback({ code: GOOD_CODE, state })
    const session = locationOf(response).searchParams.get('oauth')
    expect(session).toMatch(/^[A-Za-z0-9_-]{43}$/)
    return session ?? ''
  }

  describe('start', () => {
    it('returns the address of the dialog with a state of 256 bits, kept in Redis by its digest only', async () => {
      const { oauth } = login()
      const { id } = await register(oauth)
      const state = await start(id)
      expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/)
      const kept = await redis.get(CacheKeys.channel.oauthState(hashToken(state)))
      expect(JSON.parse(kept ?? 'null')).toEqual({
        userId: ctx.adminA.id,
        storeId: ctx.storeA.id,
        pluginId: id
      })
      // The value the browser holds is not a key, and is nowhere in Redis
      expect(await redis.exists(CacheKeys.channel.oauthState(state))).toBe(0)
      expect(kept).not.toContain(state)
      const ttl = await redis.ttl(CacheKeys.channel.oauthState(hashToken(state)))
      expect(ttl).toBeGreaterThan(0)
      expect(ttl).toBeLessThanOrEqual(ChannelOAuthLimits.STATE_TTL_SECONDS)
    })

    it.each([
      [
        'an address that is not https',
        (state: string, uri: string) =>
          `http://dialog.example/oauth?state=${state}&redirect_uri=${encodeURIComponent(uri)}`
      ],
      [
        'another state',
        (_state: string, uri: string) =>
          `https://dialog.example/oauth?state=other&redirect_uri=${encodeURIComponent(uri)}`
      ],
      [
        'no state',
        (_state: string, uri: string) =>
          `https://dialog.example/oauth?redirect_uri=${encodeURIComponent(uri)}`
      ],
      [
        'a repeated state',
        (state: string, uri: string) =>
          `https://dialog.example/oauth?state=${state}&state=x&redirect_uri=${encodeURIComponent(uri)}`
      ],
      [
        'another callback',
        (state: string) =>
          `https://dialog.example/oauth?state=${state}&redirect_uri=https%3A%2F%2Fevil.example%2Fcb`
      ],
      [
        'a dialog on another site than the one it declared',
        (state: string, uri: string) =>
          `https://evil.example/oauth?state=${state}&redirect_uri=${encodeURIComponent(uri)}`
      ],
      [
        'a dialog on the declared host with a port',
        (state: string, uri: string) =>
          `https://dialog.example:8443/oauth?state=${state}&redirect_uri=${encodeURIComponent(uri)}`
      ],
      [
        'a dialog on a subdomain of the declared host',
        (state: string, uri: string) =>
          `https://evil.dialog.example/oauth?state=${state}&redirect_uri=${encodeURIComponent(uri)}`
      ],
      [
        'a repeated callback',
        (state: string, uri: string) =>
          `https://dialog.example/oauth?state=${state}&redirect_uri=${encodeURIComponent(uri)}&redirect_uri=https%3A%2F%2Fevil.example%2Fcb`
      ],
      [
        'a dialog address with a login in it',
        (state: string, uri: string) =>
          `https://user:secret@dialog.example/oauth?state=${state}&redirect_uri=${encodeURIComponent(uri)}`
      ],
      [
        'a dialog address with a fragment',
        (state: string, uri: string) =>
          `https://dialog.example/oauth?state=${state}&redirect_uri=${encodeURIComponent(uri)}#x`
      ],
      ['something that is not an address', () => 'not an address']
    ])('refuses a plugin that makes %s, and keeps no state for it', async (_name, make) => {
      const { oauth } = login({
        authorizationUrl: ({ state, redirectUri }) => make(state, redirectUri)
      })
      const { id } = await register(oauth)
      // No state is kept for an address that was refused (the spy, not a count of keys in a Redis that every
      // suite shares)
      const saved = jest.spyOn(app.get(ChannelOAuthStore, { strict: false }), 'saveState')
      try {
        const response = await asAdmin().post(ApiRoutes.channels.oauthStart(id))
        expect(response.status).toBe(BAD_REQUEST)
        expect((response.body as ErrorBody).error.metadata).toEqual({
          reason: ChannelConnectFailureReasons.PROVIDER_ANSWER_UNEXPECTED
        })
        expect(JSON.stringify(response.body)).not.toContain('evil.example')
        expect(saved).not.toHaveBeenCalled()
      } finally {
        saved.mockRestore()
      }
    })

    it('refuses, as a bad answer of the plugin, an address that cannot be made', async () => {
      const { oauth } = login({
        authorizationUrl: () => {
          throw new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, { retryable: false })
        }
      })
      const { id } = await register(oauth)
      const response = await asAdmin().post(ApiRoutes.channels.oauthStart(id))
      expect(response.status).toBe(BAD_REQUEST)
      expect((response.body as ErrorBody).error.metadata).toEqual({
        reason: ChannelConnectFailureReasons.PROVIDER_ANSWER_UNEXPECTED
      })
    })

    it('makes a new state every time', async () => {
      const { id } = await register(login().oauth)
      expect(await start(id)).not.toBe(await start(id))
    })

    it('needs a login and the permission to edit settings', async () => {
      const { id } = await register(login().oauth)
      expect((await anonymousApi(app).post(ApiRoutes.channels.oauthStart(id))).status).toBe(
        UNAUTHORIZED
      )
      expect((await asAgent().post(ApiRoutes.channels.oauthStart(id))).status).toBe(FORBIDDEN)
    })

    it('answers 404 for a plugin with no login, one that does not exist and one the store cannot see', async () => {
      const without = await register(undefined)
      for (const pluginId of [without.id, 'nobody_here']) {
        const response = await asAdmin().post(ApiRoutes.channels.oauthStart(pluginId))
        expect(response.status).toBe(NOT_FOUND)
        expect(codeOf(response.body)).toBe(ErrorCodes.RESOURCE_NOT_FOUND)
      }
    })

    it('refuses a plugin the store has not installed, before the person leaves for the provider', async () => {
      const { id } = await register(login().oauth)
      const response = await asAdminA2().post(ApiRoutes.channels.oauthStart(id))
      expect(response.status).toBe(CONFLICT)
      expect(codeOf(response.body)).toBe(ErrorCodes.PLUGIN_NOT_INSTALLED)
    })
  })

  describe('the callback', () => {
    it('is public, makes no connection and sends the browser to the settings with an opaque session id', async () => {
      const { oauth, calls } = login()
      const { id } = await register(oauth)
      const before = await owner.channelConnection.count({ where: { pluginId: id } })
      const state = await start(id)
      const response = await callback({ code: GOOD_CODE, state })
      expect(response.status).toBe(FOUND)
      expect(response.headers['referrer-policy']).toBe('no-referrer')
      expect(response.headers['cache-control']).toBe('no-store')
      const location = locationOf(response)
      expect(`${location.origin}${location.pathname}`).toBe(
        `${FRONTEND}/s/${ctx.storeA.id}/settings/channels`
      )
      expect([...location.searchParams.keys()]).toEqual(['oauth'])
      // The browser never learns the token, the code or the state
      for (const secret of [USER_TOKEN, GOOD_CODE, state])
        expect(location.href).not.toContain(secret)
      expect(calls.exchange).toHaveBeenCalledWith({ code: GOOD_CODE, redirectUri: REDIRECT_URI })
      expect(await owner.channelConnection.count({ where: { pluginId: id } })).toBe(before)
    })

    it('keeps the token of the person sealed, under the digest of the session id', async () => {
      const { id } = await register(login().oauth)
      const session = await sessionOf(id)
      const raw = await redis.get(CacheKeys.channel.oauthSession(hashToken(session)))
      expect(raw).not.toBeNull()
      expect(raw).not.toContain(USER_TOKEN)
      expect(raw).not.toContain(session)
      const record = JSON.parse(raw ?? '{}') as { userId: string; storeId: string; sealed: string }
      expect(record.userId).toBe(ctx.adminA.id)
      expect(record.storeId).toBe(ctx.storeA.id)
      const ttl = await redis.ttl(CacheKeys.channel.oauthSession(hashToken(session)))
      expect(ttl).toBeLessThanOrEqual(ChannelOAuthLimits.SESSION_TTL_SECONDS)
      // And it opens only with the key of the credentials
      const key = app.get(CredentialCipher, { strict: false })
      expect(key.open(Buffer.from(record.sealed, 'base64'))).toEqual({ userToken: USER_TOKEN })
    })

    it('reads the state once: the second callback with it finds nothing', async () => {
      const { oauth, calls } = login()
      const { id } = await register(oauth)
      const state = await start(id)
      expect((await callback({ code: GOOD_CODE, state })).status).toBe(FOUND)
      const again = await callback({ code: GOOD_CODE, state })
      expect(locationOf(again).searchParams.get('oauth_error')).toBe(
        ChannelConnectFailureReasons.OAUTH_EXPIRED
      )
      expect(calls.exchange).toHaveBeenCalledTimes(1)
    })

    it('lets only one of two callbacks at the same time use the state', async () => {
      const { oauth, calls } = login()
      const { id } = await register(oauth)
      const state = await start(id)
      const answers = await Promise.all([
        callback({ code: GOOD_CODE, state }),
        callback({ code: GOOD_CODE, state })
      ])
      const sessions = answers.filter(answer => locationOf(answer).searchParams.has('oauth'))
      expect(sessions).toHaveLength(1)
      expect(calls.exchange).toHaveBeenCalledTimes(1)
    })

    it.each([
      ['no parameters', {}],
      ['a state of another shape', { state: 'short', code: GOOD_CODE }],
      ['a state nobody made', { state: 'x'.repeat(43), code: GOOD_CODE }],
      ['a repeated state', { state: ['a'.repeat(43), 'b'.repeat(43)], code: GOOD_CODE }],
      [
        'a state with characters outside the alphabet',
        { state: `${'a'.repeat(42)}!`, code: GOOD_CODE }
      ]
    ])(
      'sends %s to the root with the reason expired, and says nothing it was given',
      async (_name, query) => {
        const response = await callback(query)
        expect(response.status).toBe(FOUND)
        const location = locationOf(response)
        expect(location.pathname).toBe('/')
        expect(location.searchParams.get('oauth_error')).toBe(
          ChannelConnectFailureReasons.OAUTH_EXPIRED
        )
        expect(location.href).not.toContain('x'.repeat(43))
      }
    )

    it('says cancelled when the person said no, and uses up the state', async () => {
      const { id } = await register(login().oauth)
      const state = await start(id)
      const response = await callback({
        error: 'access_denied',
        error_reason: 'user_denied',
        error_description: 'Text that Meta wrote and that must not travel',
        state
      })
      const location = locationOf(response)
      expect(location.pathname).toBe(`/s/${ctx.storeA.id}/settings/channels`)
      expect(location.searchParams.get('oauth_error')).toBe(
        ChannelConnectFailureReasons.OAUTH_CANCELLED
      )
      expect(location.href).not.toContain('Meta wrote')
      expect(await redis.exists(CacheKeys.channel.oauthState(hashToken(state)))).toBe(0)
    })

    it.each([
      ['a code that is missing', {}],
      ['a repeated code', { code: [GOOD_CODE, GOOD_CODE] }],
      ['a code with spaces', { code: 'good code' }],
      ['a code that is too long', { code: 'c'.repeat(3000) }]
    ])('says expired for %s, with no call to the provider', async (_name, extra) => {
      const { oauth, calls } = login()
      const { id } = await register(oauth)
      const state = await start(id)
      const response = await callback({ state, ...extra })
      expect(locationOf(response).searchParams.get('oauth_error')).toBe(
        ChannelConnectFailureReasons.OAUTH_EXPIRED
      )
      expect(calls.exchange).not.toHaveBeenCalled()
    })

    it('names a reason of the closed list, and keeps no session, when the code is refused', async () => {
      const { id } = await register(login().oauth)
      const state = await start(id)
      const response = await callback({ code: 'a-code-meta-refuses', state })
      const location = locationOf(response)
      const reason = location.searchParams.get('oauth_error')
      expect(Object.values(ChannelConnectFailureReasons)).toContain(reason)
      expect(location.searchParams.has('oauth')).toBe(false)
      expect(location.href).not.toContain('a-code-meta-refuses')
    })

    it('sends the browser back to try again, and not to a page of errors, when Redis fails after the exchange', async () => {
      const { id } = await register(login().oauth)
      const state = await start(id)
      const store = app.get(ChannelOAuthStore, { strict: false })
      const spy = jest.spyOn(store, 'saveSession').mockRejectedValueOnce(new Error('redis down'))
      try {
        const response = await callback({ code: GOOD_CODE, state })
        expect(response.status).toBe(FOUND)
        const location = locationOf(response)
        expect(location.pathname).toBe(`/s/${ctx.storeA.id}/settings/channels`)
        expect(location.searchParams.get('oauth_error')).toBe(
          ChannelConnectFailureReasons.PROVIDER_UNAVAILABLE
        )
        expect(location.searchParams.has('oauth')).toBe(false)
      } finally {
        spy.mockRestore()
      }
    })

    it.each([
      ['access_denied', ChannelConnectFailureReasons.OAUTH_CANCELLED],
      ['server_error', ChannelConnectFailureReasons.PROVIDER_UNAVAILABLE],
      ['temporarily_unavailable', ChannelConnectFailureReasons.PROVIDER_UNAVAILABLE],
      ['invalid_scope', ChannelConnectFailureReasons.REQUEST_REJECTED],
      ['whatever-else-it-sends', ChannelConnectFailureReasons.REQUEST_REJECTED]
    ])('tells the error %s of the provider apart, without repeating it', async (error, reason) => {
      const { id } = await register(login().oauth)
      const state = await start(id)
      const location = locationOf(await callback({ error, state }))
      expect(location.searchParams.get('oauth_error')).toBe(reason)
      expect(location.href).not.toContain(error)
    })

    it('sends the browser back with the reason of an answer that holds no token', async () => {
      const { oauth } = login({ exchangeCode: () => Promise.resolve(undefined as never) })
      const { id } = await register(oauth)
      const state = await start(id)
      const location = locationOf(await callback({ code: GOOD_CODE, state }))
      expect(location.searchParams.get('oauth_error')).toBe(
        ChannelConnectFailureReasons.PROVIDER_ANSWER_UNEXPECTED
      )
      expect(location.searchParams.has('oauth')).toBe(false)
    })

    it('answers 429 from the request after the limit, per address, and not before', async () => {
      // An address of this run only: the counter lives in a Redis that every run shares for a minute
      const address = `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`
      const hit = () =>
        anonymousApi(app)
          .get(ApiRoutes.channels.oauthCallback)
          .set('x-forwarded-for', address)
          .redirects(0)
      for (let attempt = 0; attempt < ChannelOAuthLimits.CALLBACK_LIMIT_PER_MINUTE; attempt += 1) {
        expect((await hit()).status).toBe(FOUND)
      }
      expect((await hit()).status).toBe(TOO_MANY)
    })
  })

  describe('the session', () => {
    it('lists the Pages of the person who started it, with nothing else a plugin returned', async () => {
      const { oauth } = login({
        listAssets: () =>
          Promise.resolve([
            {
              id: '1100',
              name: 'Page A',
              linkedAccount: { id: '1800', username: 'shop' },
              token: 'LEAK'
            } as never
          ])
      })
      const { id } = await register(oauth)
      const session = await sessionOf(id)
      const response = await asAdmin().get(ApiRoutes.channels.oauthAssets(session))
      expect(response.status).toBe(OK)
      expect(response.body as SessionBody).toEqual({
        pluginId: id,
        connectionId: null,
        repairAccountId: null,
        assets: [{ id: '1100', name: 'Page A', linkedAccount: { id: '1800', username: 'shop' } }]
      })
      expect(JSON.stringify(response.body)).not.toContain('LEAK')
      expect(JSON.stringify(response.body)).not.toContain(USER_TOKEN)
    })

    it('lists only the ids that fit the pattern the plugin declared, whatever they look like', async () => {
      const { oauth } = login({
        assetIdPattern: '^[a-z]{8,12}$',
        listAssets: () =>
          Promise.resolve([
            { id: 'abcdefgh', name: 'Letters', linkedAccount: null },
            { id: '12345678', name: 'Digits', linkedAccount: null },
            { id: 12345678, name: 'A number', linkedAccount: null } as never
          ])
      })
      const { id } = await register(oauth)
      const session = await sessionOf(id)

      const response = await asAdmin().get(ApiRoutes.channels.oauthAssets(session))

      expect(response.status).toBe(OK)
      expect((response.body as SessionBody).assets.map(asset => asset.id)).toEqual(['abcdefgh'])
    })

    it('keeps the choice when the account it links has an id of another shape, and cuts a name by characters', async () => {
      const { oauth } = login({
        assetIdPattern: '^[a-z]{8,12}$',
        listAssets: () =>
          Promise.resolve([
            {
              id: 'abcdefgh',
              name: `${'x'.repeat(199)}😀\u202e`,
              linkedAccount: { id: '17841400000000000', username: 'shop' }
            }
          ])
      })
      const { id } = await register(oauth)
      const session = await sessionOf(id)

      const response = await asAdmin().get(ApiRoutes.channels.oauthAssets(session))

      const [asset] = (response.body as SessionBody).assets
      expect(asset?.linkedAccount).toEqual({ id: '17841400000000000', username: 'shop' })
      expect(asset?.name).toBe(`${'x'.repeat(199)}😀`)
    })

    it('holds the id it is given to the declared pattern before it asks the provider anything', async () => {
      const { oauth, calls } = login({ assetIdPattern: '^[a-z]{8,12}$' })
      const { id } = await register(oauth)
      const session = await sessionOf(id)
      calls.granted.mockClear()

      const digits = await asAdmin()
        .post(ApiRoutes.channels.oauthComplete(session))
        .send({ assetId: '12345678' })
      const letters = await asAdmin()
        .post(ApiRoutes.channels.oauthComplete(session))
        .send({ assetId: 'abcdefgh' })

      expect(digits.status).toBe(BAD_REQUEST)
      expect(codeOf(digits.body)).toBe(ErrorCodes.VALIDATION_FAILED)
      expect(letters.status).toBe(CREATED)
      // The provider heard of the second only
      expect(calls.granted).toHaveBeenCalledTimes(1)
    })

    it('names the permission the person cleared in the dialog', async () => {
      const { oauth } = login({ grantedScopes: () => Promise.resolve(['pages_show_list']) })
      const { id } = await register(oauth)
      const session = await sessionOf(id)
      const response = await asAdmin().get(ApiRoutes.channels.oauthAssets(session))
      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.CHANNEL_CREDENTIALS_INVALID)
      expect((response.body as ErrorBody).error.metadata).toEqual({
        reason: ChannelConnectFailureReasons.PERMISSION_MISSING,
        missingPermissions: ['pages_messaging']
      })
    })

    it('says nothing the provider said when it fails', async () => {
      const { oauth } = login({
        listAssets: () =>
          Promise.reject(
            new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, { retryable: false })
          )
      })
      const { id } = await register(oauth)
      const session = await sessionOf(id)
      const response = await asAdmin().get(ApiRoutes.channels.oauthAssets(session))
      expect(response.status).toBe(BAD_REQUEST)
      expect(JSON.stringify(response.body)).not.toContain(USER_TOKEN)
    })

    // One answer for every session that is not yours, so that the id of another person's session tells nothing
    it('is the same 404 for a session of another user, of another store, that expired or never was', async () => {
      const { id } = await register(login().oauth)
      const session = await sessionOf(id)
      const never = 'n'.repeat(43)
      const answers = [
        await asOtherAdmin().get(ApiRoutes.channels.oauthAssets(session)),
        await asAdminB().get(ApiRoutes.channels.oauthAssets(session)),
        await asAdminA2().get(ApiRoutes.channels.oauthAssets(session)),
        await asAdmin().get(ApiRoutes.channels.oauthAssets(never))
      ]
      for (const answer of answers) {
        expect(answer.status).toBe(NOT_FOUND)
        // Everything but the id of the request, which is each one's own
        expect((answer.body as ErrorBody).error).toEqual((answers[3]?.body as ErrorBody).error)
      }
      // Completing or dropping it is refused the same way, and leaves it alone
      const body = { assetId: '1100' }
      expect(
        (await asOtherAdmin().post(ApiRoutes.channels.oauthComplete(session)).send(body)).status
      ).toBe(NOT_FOUND)
      expect(
        (await asAdminB().post(ApiRoutes.channels.oauthComplete(session)).send(body)).status
      ).toBe(NOT_FOUND)
      expect((await asOtherAdmin().delete(ApiRoutes.channels.oauthSession(session))).status).toBe(
        NOT_FOUND
      )
      expect((await asAdminB().delete(ApiRoutes.channels.oauthSession(session))).status).toBe(
        NOT_FOUND
      )
      expect((await asAdmin().get(ApiRoutes.channels.oauthAssets(session))).status).toBe(OK)
    })

    // The same person, in a store of their own that is not the one that started the login: the user alone does
    // not open it, the store has to be the same too
    it('is a 404 for the same person asking from another store they belong to', async () => {
      const { id } = await register(login().oauth)
      await ensurePluginInstallation(owner, { storeId: ctx.storeA2.id, pluginId: id })
      await ensureMembership(owner, {
        userId: ctx.adminA.id,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA2.id,
        roleId: ctx.roleIds[RoleNames.ADMIN]
      })
      try {
        const session = await sessionOf(id)
        const fromOtherStore = () => api(app, ctx.adminA, ctx.storeA2)
        expect((await fromOtherStore().get(ApiRoutes.channels.oauthAssets(session))).status).toBe(
          NOT_FOUND
        )
        expect(
          (
            await fromOtherStore()
              .post(ApiRoutes.channels.oauthComplete(session))
              .send({ assetId: '1100' })
          ).status
        ).toBe(NOT_FOUND)
        expect(
          (await fromOtherStore().delete(ApiRoutes.channels.oauthSession(session))).status
        ).toBe(NOT_FOUND)
        expect((await asAdmin().get(ApiRoutes.channels.oauthAssets(session))).status).toBe(OK)
      } finally {
        // The shared context is left as it was: adminA belongs to its own store alone
        await owner.membership.deleteMany({
          where: { userId: ctx.adminA.id, storeId: ctx.storeA2.id }
        })
      }
    })

    it('is not reached by a person without the permission', async () => {
      const { id } = await register(login().oauth)
      const session = await sessionOf(id)
      expect((await asAgent().get(ApiRoutes.channels.oauthAssets(session))).status).toBe(FORBIDDEN)
      expect((await anonymousApi(app).get(ApiRoutes.channels.oauthAssets(session))).status).toBe(
        UNAUTHORIZED
      )
    })

    it('is a 404 once the plugin is gone, as if the session never existed', async () => {
      const { oauth } = login()
      const { id } = await register(oauth)
      const session = await sessionOf(id)
      registry.unregister(id)
      registered.splice(registered.indexOf(id), 1)
      expect((await asAdmin().get(ApiRoutes.channels.oauthAssets(session))).status).toBe(NOT_FOUND)
    })

    it('can be dropped even when its token can no longer be read', async () => {
      const { id } = await register(login().oauth)
      const session = await sessionOf(id)
      const key = CacheKeys.channel.oauthSession(hashToken(session))
      const record = JSON.parse((await redis.get(key)) ?? '{}') as Record<string, unknown>
      await redis.set(
        key,
        JSON.stringify({ ...record, sealed: Buffer.from('not ours').toString('base64') })
      )
      // It cannot be used, and it can be removed
      expect((await asAdmin().get(ApiRoutes.channels.oauthAssets(session))).status).toBe(NOT_FOUND)
      expect((await asAdmin().delete(ApiRoutes.channels.oauthSession(session))).status).toBe(
        NO_CONTENT
      )
      expect(await redis.exists(key)).toBe(0)
    })

    it('is dropped on request, once', async () => {
      const { id } = await register(login().oauth)
      const session = await sessionOf(id)
      expect((await asAdmin().delete(ApiRoutes.channels.oauthSession(session))).status).toBe(
        NO_CONTENT
      )
      expect((await asAdmin().get(ApiRoutes.channels.oauthAssets(session))).status).toBe(NOT_FOUND)
      expect((await asAdmin().delete(ApiRoutes.channels.oauthSession(session))).status).toBe(
        NOT_FOUND
      )
    })

    it('refuses an id that is not the shape of one, before any lookup', async () => {
      for (const bad of ['short', 'a'.repeat(44), `${'a'.repeat(42)}$`]) {
        expect((await asAdmin().get(ApiRoutes.channels.oauthAssets(bad))).status).toBe(BAD_REQUEST)
      }
    })
  })

  describe('complete', () => {
    it('connects the Page chosen, over the same connect, and uses the session up', async () => {
      const { oauth, calls } = login()
      // A plugin that tries to say how it was connected is not believed
      const { id, connectionId } = await register(oauth, undefined, {
        region: 'sv',
        authMethod: 'plugin-says-so'
      })
      const session = await sessionOf(id)
      const response = await asAdmin()
        .post(ApiRoutes.channels.oauthComplete(session))
        .send({ assetId: '1100' })
      expect(response.status).toBe(CREATED)
      expect(calls.credentials).toHaveBeenCalledWith({ userToken: USER_TOKEN, assetId: '1100' })
      expect(JSON.stringify(response.body)).not.toContain(PAGE_TOKEN_PREFIX)
      expect(JSON.stringify(response.body)).not.toContain(USER_TOKEN)

      const row = await owner.channelConnection.findFirstOrThrow({
        where: { pluginId: id, connectionId }
      })
      expect(row.storeId).toBe(ctx.storeA.id)
      // How it was connected is ours to say, whatever the plugin put in its metadata
      expect(row.metadata).toEqual({ region: 'sv', authMethod: ChannelAuthMethods.FACEBOOK_LOGIN })
      const key = app.get(CredentialCipher, { strict: false })
      expect(key.open(row.credentials)).toEqual({ token: `${PAGE_TOKEN_PREFIX}1100` })
      // The credentials are not in the metadata, and the token of the person is nowhere in the row
      expect(JSON.stringify(row.metadata)).not.toContain(PAGE_TOKEN_PREFIX)
      expect(Buffer.from(row.credentials).toString('latin1')).not.toContain(USER_TOKEN)

      // Written after the answer: waited for, not read at once
      const entries = await waitForAuditEntries(owner, {
        resourceId: row.id,
        action: AuditAction.CHANNEL_CONNECTED
      })
      expect(entries).toHaveLength(1)
      expect(entries[0]?.metadata).toEqual({
        pluginId: id,
        authMethod: ChannelAuthMethods.FACEBOOK_LOGIN
      })

      // The session is gone: it cannot make a second connection
      const again = await asAdmin()
        .post(ApiRoutes.channels.oauthComplete(session))
        .send({ assetId: '1100' })
      expect(again.status).toBe(NOT_FOUND)
    })

    it('does not connect with a permission the person cleared, even when it goes straight to complete', async () => {
      const { oauth } = login({ grantedScopes: () => Promise.resolve(['pages_show_list']) })
      const { id, connectionId } = await register(oauth)
      const session = await sessionOf(id)
      // No call to list the Pages first: a client that skips it is held to the same rule
      const response = await asAdmin()
        .post(ApiRoutes.channels.oauthComplete(session))
        .send({ assetId: '1100' })
      expect(response.status).toBe(BAD_REQUEST)
      expect((response.body as ErrorBody).error.metadata).toEqual({
        reason: ChannelConnectFailureReasons.PERMISSION_MISSING,
        missingPermissions: ['pages_messaging']
      })
      expect(await owner.channelConnection.count({ where: { pluginId: id, connectionId } })).toBe(0)
    })

    it('answers success when the connection was made but the session could not be removed', async () => {
      const { id, connectionId } = await register(login().oauth)
      const session = await sessionOf(id)
      const store = app.get(ChannelOAuthStore, { strict: false })
      const spy = jest.spyOn(store, 'deleteSession').mockRejectedValueOnce(new Error('redis down'))
      try {
        const response = await asAdmin()
          .post(ApiRoutes.channels.oauthComplete(session))
          .send({ assetId: '1100' })
        expect(response.status).toBe(CREATED)
        expect(await owner.channelConnection.count({ where: { pluginId: id, connectionId } })).toBe(
          1
        )
      } finally {
        spy.mockRestore()
      }
    })

    it('writes no authMethod for a connection made with what the person pasted', async () => {
      const { id, connectionId } = await register(login().oauth)
      const response = await asAdmin()
        .post(ApiRoutes.channels.connect(id))
        .send({ credentials: { token: 'pasted' } })
      expect(response.status).toBe(CREATED)
      const row = await owner.channelConnection.findFirstOrThrow({
        where: { pluginId: id, connectionId }
      })
      expect(row.metadata).toEqual({ region: 'sv' })
    })

    it('leaves the session for another try when the provider refuses the Page', async () => {
      const { oauth } = login({
        credentialsFor: ({ assetId }) =>
          assetId === '1100'
            ? Promise.reject(
                new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, {
                  retryable: false,
                  reason: ChannelConnectFailureReasons.NO_ASSETS
                })
              )
            : Promise.resolve({ token: 'PAGE-ok' })
      })
      const { id } = await register(oauth)
      const session = await sessionOf(id)
      const refused = await asAdmin()
        .post(ApiRoutes.channels.oauthComplete(session))
        .send({ assetId: '1100' })
      expect(refused.status).toBe(BAD_REQUEST)
      expect((refused.body as ErrorBody).error.metadata).toEqual({
        reason: ChannelConnectFailureReasons.NO_ASSETS
      })
      const retried = await asAdmin()
        .post(ApiRoutes.channels.oauthComplete(session))
        .send({ assetId: '1200' })
      expect(retried.status).toBe(CREATED)
    })

    it('keeps the rules of the connection: an account of another store is a conflict, and the session stays', async () => {
      const sharedAccount = `acct-${randomUUID()}`
      const { id } = await register(login().oauth, sharedAccount)
      const first = await sessionOf(id, asAdminB)
      expect(
        (await asAdminB().post(ApiRoutes.channels.oauthComplete(first)).send({ assetId: '1100' }))
          .status
      ).toBe(CREATED)
      const second = await sessionOf(id)
      const refused = await asAdmin()
        .post(ApiRoutes.channels.oauthComplete(second))
        .send({ assetId: '1100' })
      expect(refused.status).toBe(CONFLICT)
      expect(codeOf(refused.body)).toBe(ErrorCodes.CHANNEL_ACCOUNT_IN_USE)
      expect((await asAdmin().get(ApiRoutes.channels.oauthAssets(second))).status).toBe(OK)
    })

    it.each([
      [{}],
      [{ assetId: '' }],
      [{ assetId: '../me' }],
      [{ assetId: '12ab' }],
      [{ assetId: '1100', extra: 1 }]
    ])('refuses the body %j', async body => {
      const { id } = await register(login().oauth)
      const session = await sessionOf(id)
      const response = await asAdmin().post(ApiRoutes.channels.oauthComplete(session)).send(body)
      expect(response.status).toBe(BAD_REQUEST)
    })
  })

  describe('repairing a connection', () => {
    // The account of a connection is the Page whose token it holds, so that another Page is another account
    async function registerByPage(oauth: ChannelOAuth) {
      counter += 1
      const id = `oa_${counter}`
      registry.register(
        buildChannelPlugin({
          id,
          oauth,
          connect: input =>
            Promise.resolve({
              connectionId: `acct-${String(input.credentials['token'])}`,
              displayName: 'Acme page',
              credentials: input.credentials,
              metadata: { region: 'sv' }
            })
        })
      )
      registered.push(id)
      for (const store of [ctx.storeA, ctx.storeB]) {
        await ensurePluginInstallation(owner, { storeId: store.id, pluginId: id })
      }
      return id
    }
    // A connection made through the login, then left in error as a token that expired would leave it
    async function brokenConnection(pluginId: string) {
      const session = await sessionOf(pluginId)
      const made = await asAdmin()
        .post(ApiRoutes.channels.oauthComplete(session))
        .send({ assetId: '1100' })
      expect(made.status).toBe(CREATED)
      const row = await owner.channelConnection.findFirstOrThrow({
        where: { pluginId, storeId: ctx.storeA.id }
      })
      await owner.channelConnection.update({
        where: { id: row.id },
        data: { status: ChannelConnectionStatus.ERROR, lastError: 'token_rejected' }
      })
      return row
    }
    const startFor = (pluginId: string, body: Record<string, unknown>) =>
      asAdmin().post(ApiRoutes.channels.oauthStart(pluginId)).send(body)
    async function repairSession(pluginId: string, connectionId: string): Promise<string> {
      const started = await startFor(pluginId, { connectionId })
      expect(started.status).toBe(OK)
      const state = stateOf((started.body as { authorizeUrl: string }).authorizeUrl)
      const location = locationOf(await callback({ code: GOOD_CODE, state }))
      // The connection travels in the state in Redis, never in the address
      expect([...location.searchParams.keys()]).toEqual(['oauth'])
      expect(location.href).not.toContain(connectionId)
      return location.searchParams.get('oauth') ?? ''
    }

    it('repairs the connection it was started from with the same Page, in the same row', async () => {
      const id = await registerByPage(login().oauth)
      const row = await brokenConnection(id)
      const session = await repairSession(id, row.id)
      const listed = await asAdmin().get(ApiRoutes.channels.oauthAssets(session))
      expect((listed.body as { connectionId: string | null }).connectionId).toBe(row.id)
      // And which account that connection is, so that the screen can mark its Page
      expect((listed.body as { repairAccountId: string | null }).repairAccountId).toBe(
        row.connectionId
      )

      const response = await asAdmin()
        .post(ApiRoutes.channels.oauthComplete(session))
        .send({ assetId: '1100' })
      expect(response.status).toBe(CREATED)
      expect((response.body as { id: string }).id).toBe(row.id)
      const after = await owner.channelConnection.findUniqueOrThrow({ where: { id: row.id } })
      expect(after.status).toBe(ChannelConnectionStatus.ACTIVE)
      expect(after.lastError).toBeNull()
      expect(after.metadata).toEqual({
        region: 'sv',
        authMethod: ChannelAuthMethods.FACEBOOK_LOGIN
      })
      expect(await owner.channelConnection.count({ where: { pluginId: id } })).toBe(1)
      // Written after the answer: waited for, not read at once
      const entries = await waitForAuditEntries(owner, {
        resourceId: row.id,
        action: AuditAction.CHANNEL_TOKEN_UPDATED
      })
      expect(entries).toHaveLength(1)
      expect(entries[0]?.metadata).toEqual({
        pluginId: id,
        authMethod: ChannelAuthMethods.FACEBOOK_LOGIN
      })
      // Used up
      expect((await asAdmin().get(ApiRoutes.channels.oauthAssets(session))).status).toBe(NOT_FOUND)
    })

    it('refuses another Page as another account, writes nothing and leaves the session for another try', async () => {
      const id = await registerByPage(login().oauth)
      const row = await brokenConnection(id)
      const session = await repairSession(id, row.id)

      const refused = await asAdmin()
        .post(ApiRoutes.channels.oauthComplete(session))
        .send({ assetId: '1200' })
      expect(refused.status).toBe(BAD_REQUEST)
      expect((refused.body as ErrorBody).error.metadata).toEqual({
        reason: ChannelConnectFailureReasons.OTHER_ACCOUNT
      })
      const after = await owner.channelConnection.findUniqueOrThrow({ where: { id: row.id } })
      expect(Buffer.from(after.credentials).equals(Buffer.from(row.credentials))).toBe(true)
      expect(after.status).toBe(ChannelConnectionStatus.ERROR)
      expect(await owner.channelConnection.count({ where: { pluginId: id } })).toBe(1)
      expect((await asAdmin().get(ApiRoutes.channels.oauthAssets(session))).status).toBe(OK)
      const retried = await asAdmin()
        .post(ApiRoutes.channels.oauthComplete(session))
        .send({ assetId: '1100' })
      expect(retried.status).toBe(CREATED)
    })

    it('is a 404 to repair a connection of another store, of another plugin or that does not exist', async () => {
      const id = await registerByPage(login().oauth)
      const other = await registerByPage(login().oauth)
      const row = await brokenConnection(id)
      const saved = jest.spyOn(app.get(ChannelOAuthStore, { strict: false }), 'saveState')
      try {
        const foreign = await api(app, ctx.adminB, ctx.storeB)
          .post(ApiRoutes.channels.oauthStart(id))
          .send({ connectionId: row.id })
        const elsewhere = await startFor(other, { connectionId: row.id })
        const missing = await startFor(id, { connectionId: randomUUID() })
        for (const answer of [foreign, elsewhere, missing]) {
          expect(answer.status).toBe(NOT_FOUND)
          expect((answer.body as ErrorBody).error).toEqual((foreign.body as ErrorBody).error)
        }
        expect(saved).not.toHaveBeenCalled()
      } finally {
        saved.mockRestore()
      }
    })

    it('refuses to finish a repair when the connection was disconnected meanwhile, and writes nothing', async () => {
      const id = await registerByPage(login().oauth)
      const row = await brokenConnection(id)
      const session = await repairSession(id, row.id)
      await owner.channelConnection.update({
        where: { id: row.id },
        data: { status: ChannelConnectionStatus.DISCONNECTED }
      })
      const response = await asAdmin()
        .post(ApiRoutes.channels.oauthComplete(session))
        .send({ assetId: '1100' })
      expect(response.status).toBe(CONFLICT)
      const after = await owner.channelConnection.findUniqueOrThrow({ where: { id: row.id } })
      expect(after.status).toBe(ChannelConnectionStatus.DISCONNECTED)
      expect(Buffer.from(after.credentials).equals(Buffer.from(row.credentials))).toBe(true)
    })

    it('refuses to repair a connection that was disconnected', async () => {
      const id = await registerByPage(login().oauth)
      const row = await brokenConnection(id)
      await owner.channelConnection.update({
        where: { id: row.id },
        data: { status: ChannelConnectionStatus.DISCONNECTED }
      })
      expect((await startFor(id, { connectionId: row.id })).status).toBe(CONFLICT)
    })

    it.each([[{ connectionId: 'not-a-uuid' }], [{ connectionId: 1 }], [{ other: 'x' }]])(
      'refuses the body %j',
      async body => {
        const id = await registerByPage(login().oauth)
        expect((await startFor(id, body)).status).toBe(BAD_REQUEST)
      }
    )
  })

  describe('the routes', () => {
    it('are reached by their own handlers and not captured by a route of the connections', async () => {
      const unknown = 'u'.repeat(43)
      // `/channels/connections/:id/...` takes an id that is a uuid and answers 400 for anything else; reaching
      // the login handler instead is a 404 for the session, or a 404 for the plugin
      const assets = await asAdmin().get(ApiRoutes.channels.oauthAssets(unknown))
      expect(assets.status).toBe(NOT_FOUND)
      const complete = await asAdmin()
        .post(ApiRoutes.channels.oauthComplete(unknown))
        .send({ assetId: '1' })
      expect(complete.status).toBe(NOT_FOUND)
      const cancel = await asAdmin().delete(ApiRoutes.channels.oauthSession(unknown))
      expect(cancel.status).toBe(NOT_FOUND)
      const begin = await asAdmin().post(ApiRoutes.channels.oauthStart('nobody_here'))
      expect(begin.status).toBe(NOT_FOUND)
      expect(codeOf(begin.body)).toBe(ErrorCodes.RESOURCE_NOT_FOUND)
    })

    it('says in the catalog which channels can offer the login, and no more than a flag', async () => {
      const withLogin = await register(login().oauth)
      const without = await register(undefined)
      const response = await asAdmin().get(ApiRoutes.plugins.available)
      expect(response.status).toBe(OK)
      const entries = response.body as { id: string; channel: { facebookLogin?: boolean } | null }[]
      expect(entries.find(entry => entry.id === withLogin.id)?.channel?.facebookLogin).toBe(true)
      expect(entries.find(entry => entry.id === without.id)?.channel?.facebookLogin).toBe(false)
      // Nothing about the app, the scopes or the address travels with it
      const text = JSON.stringify(response.body)
      expect(text).not.toContain(REDIRECT_URI)
      expect(text).not.toContain('pages_show_list')
    })

    it('is off, as if it did not exist, where no redirect address is set', async () => {
      const off = await createTestApp([], builder =>
        builder
          .overrideProvider(ChannelOAuthConfig)
          .useValue({ redirectUri: undefined, frontendUrl: FRONTEND })
      )
      try {
        const offRegistry = off.get(PluginRegistry, { strict: false })
        const { oauth } = login()
        counter += 1
        const id = `oa_${counter}`
        offRegistry.register(buildChannelPlugin({ id, oauth }))
        try {
          await ensurePluginInstallation(owner, { storeId: ctx.storeA.id, pluginId: id })
          const response = await api(off, ctx.adminA, ctx.storeA).post(
            ApiRoutes.channels.oauthStart(id)
          )
          expect(response.status).toBe(NOT_FOUND)
        } finally {
          offRegistry.unregister(id)
        }
      } finally {
        await off.close()
      }
    })
  })
})
