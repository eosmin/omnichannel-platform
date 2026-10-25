import { randomInt, randomUUID } from 'node:crypto'

import { ApiRoutes, API_PREFIX } from '@platform/core/api'
import { MagicLinkThrottle } from '@platform/core/auth'

import { type AuthTestApp, startAuthTestApp } from '../../testing/auth-test-app'

// The body is parsed from the wire: each test says the shape it expects
interface Reply<T = unknown> {
  status: number
  body: T
}

interface ErrorBody {
  error?: { code: string }
  correlationId?: string
}

function errorCode(reply: Reply): string | undefined {
  return (reply.body as ErrorBody).error?.code
}

const EMPTY_BODY = 204

// The whole stack of the login routes over HTTP: pipes, guards, throttler, filter and services,
// against the real Postgres and Redis
describe('AuthController', () => {
  let test: AuthTestApp

  beforeAll(async () => {
    test = await startAuthTestApp()
  })
  afterAll(() => test.cleanUp())

  // Each call comes from its own client address unless a test pins one: the limits are counted in
  // a Redis that every run shares
  function freshIp(): string {
    return `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`
  }

  async function call<T = unknown>(
    method: string,
    path: string,
    options: { body?: unknown; token?: string; ip?: string } = {}
  ): Promise<Reply<T>> {
    const response = await fetch(`${test.url}${API_PREFIX}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': options.ip ?? freshIp(),
        'user-agent': 'jest-http',
        ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` })
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    })
    const text = await response.text()
    return { status: response.status, body: (text === '' ? {} : JSON.parse(text)) as T }
  }

  async function login(): Promise<{
    user: { id: string; email: string }
    accessToken: string
    refreshToken: string
  }> {
    const user = await test.createUser()
    await call('POST', ApiRoutes.auth.magicLinkRequest, { body: { email: user.email } })
    const job = (await test.emailJobs()).filter(item => item.to === user.email).at(-1)
    const token = new URLSearchParams(new URL(String(job?.data['url'])).hash.slice(1)).get('token')
    const consumed = await call<{ session: { accessToken: string; refreshToken: string } }>(
      'POST',
      ApiRoutes.auth.magicLinkConsume,
      { body: { token } }
    )
    expect(consumed.status).toBe(200)
    return { user, ...consumed.body.session }
  }

  describe('magic link', () => {
    it('answers 202 the same for an account that exists and one that does not', async () => {
      const known = await test.createUser()

      const withAccount = await call('POST', ApiRoutes.auth.magicLinkRequest, {
        body: { email: known.email }
      })
      const without = await call('POST', ApiRoutes.auth.magicLinkRequest, {
        body: { email: `nobody-${randomUUID()}@example.com` }
      })

      expect(withAccount).toEqual({ status: 202, body: { accepted: true } })
      expect(without).toEqual(withAccount)
    })

    it('logs in through the link and returns the session and the user', async () => {
      const { user, accessToken, refreshToken } = await login()

      expect(accessToken.split('.')).toHaveLength(3)
      expect(refreshToken.length).toBeGreaterThan(30)
      const me = await call('GET', ApiRoutes.auth.me, { token: accessToken })
      expect(me.status).toBe(200)
      expect(me.body).toMatchObject({ id: user.id, email: user.email, emailVerified: true })
    })

    it('answers with the session a client needs to keep logged in, and the user', async () => {
      const user = await test.createUser()
      await call('POST', ApiRoutes.auth.magicLinkRequest, { body: { email: user.email } })
      const job = (await test.emailJobs()).filter(item => item.to === user.email).at(-1)
      const token = new URLSearchParams(new URL(String(job?.data['url'])).hash.slice(1)).get(
        'token'
      )

      const reply = await call<{
        session: Record<string, unknown>
        user: Record<string, unknown>
      }>('POST', ApiRoutes.auth.magicLinkConsume, { body: { token } })

      expect(Object.keys(reply.body.session).sort()).toEqual(
        ['accessToken', 'expiresIn', 'refreshExpiresAt', 'refreshToken', 'tokenType'].sort()
      )
      expect(reply.body.session['tokenType']).toBe('Bearer')
      expect(reply.body.session['expiresIn']).toBe(900) // The access lifetime of the test settings
      expect(new Date(String(reply.body.session['refreshExpiresAt'])).getTime()).toBeGreaterThan(
        Date.now()
      )
      expect(reply.body.user).toEqual({ id: user.id, email: user.email, name: 'Test User' })
    })

    it('answers 202 the same for an address the provider reported dead, and sends nothing', async () => {
      const dead = await test.createUser({ emailValid: false })

      const reply = await call('POST', ApiRoutes.auth.magicLinkRequest, {
        body: { email: dead.email }
      })

      expect(reply).toEqual({ status: 202, body: { accepted: true } })
      expect((await test.emailJobs()).filter(item => item.to === dead.email)).toHaveLength(0)
    })

    it('records the user agent and the client address of the login', async () => {
      const { user } = await login()

      const rows = await test.asOwner(client =>
        client.query<{ user_agent: string; ip_address: string }>(
          'SELECT user_agent, ip_address FROM sessions WHERE user_id = $1',
          [user.id]
        )
      )
      expect(rows.rows[0]?.user_agent).toBe('jest-http')
      expect(rows.rows[0]?.ip_address).toMatch(/^10\./) // The forwarded address, not 127.0.0.1
    })

    it('refuses a link that was already used with the contract', async () => {
      const user = await test.createUser()
      await call('POST', ApiRoutes.auth.magicLinkRequest, { body: { email: user.email } })
      const job = (await test.emailJobs()).filter(item => item.to === user.email).at(-1)
      const token = new URLSearchParams(new URL(String(job?.data['url'])).hash.slice(1)).get(
        'token'
      )
      await call('POST', ApiRoutes.auth.magicLinkConsume, { body: { token } })

      const again = await call('POST', ApiRoutes.auth.magicLinkConsume, { body: { token } })

      expect(again.status).toBe(401)
      expect(errorCode(again)).toBe('AUTH_TOKEN_INVALID')
      expect((again.body as ErrorBody).correlationId).toBeDefined()
    })

    it.each([
      ['no body', undefined],
      ['an address that is not one', { email: 'not-an-email' }],
      ['an address past the SMTP limit', { email: `${'a'.repeat(250)}@example.com` }],
      ['a number as the address', { email: 5 }]
    ])('rejects %s with VALIDATION_FAILED, without echoing it', async (_name, body) => {
      const reply = await call('POST', ApiRoutes.auth.magicLinkRequest, { body })

      expect(reply.status).toBe(400)
      expect(errorCode(reply)).toBe('VALIDATION_FAILED')
      expect(JSON.stringify(reply.body)).not.toContain('not-an-email')
    })

    it('rejects a token that is empty or enormous before hashing it', async () => {
      const empty = await call('POST', ApiRoutes.auth.magicLinkConsume, { body: { token: '' } })
      const huge = await call('POST', ApiRoutes.auth.magicLinkConsume, {
        body: { token: 'x'.repeat(10_000) }
      })

      expect(empty.status).toBe(400)
      expect(huge.status).toBe(400)
    })

    it('limits the requests of one client, and the next client is not affected', async () => {
      const ip = freshIp()
      const statuses: number[] = []
      for (let i = 0; i <= MagicLinkThrottle.limit; i += 1) {
        const reply = await call('POST', ApiRoutes.auth.magicLinkRequest, {
          ip,
          body: { email: `nobody-${randomUUID()}@example.com` }
        })
        statuses.push(reply.status)
      }

      expect(statuses).toEqual([...Array<number>(MagicLinkThrottle.limit).fill(202), 429])
      const other = await call('POST', ApiRoutes.auth.magicLinkRequest, {
        body: { email: `someone-${randomUUID()}@example.com` }
      })
      expect(other.status).toBe(202)
    })

    it('limits the consume of one client too', async () => {
      const ip = freshIp()
      const statuses: number[] = []
      for (let i = 0; i <= MagicLinkThrottle.limit; i += 1) {
        const reply = await call('POST', ApiRoutes.auth.magicLinkConsume, {
          ip,
          body: { token: 'wrong' }
        })
        statuses.push(reply.status)
      }

      expect(statuses).toEqual([...Array<number>(MagicLinkThrottle.limit).fill(401), 429])
    })
  })

  describe('caching', () => {
    // Raw fetch: `call` only keeps status and body, and the header is what is asserted here
    async function cacheControlOf(
      method: string,
      path: string,
      options: { body?: unknown; token?: string } = {}
    ): Promise<string | null> {
      const response = await fetch(`${test.url}${API_PREFIX}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': freshIp(),
          ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` })
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
      })
      return response.headers.get('cache-control')
    }

    it('forbids keeping the answers that carry a token or the data of a person', async () => {
      const { user, accessToken, refreshToken } = await login()
      await call('POST', ApiRoutes.auth.magicLinkRequest, { body: { email: user.email } })
      const job = (await test.emailJobs()).filter(item => item.to === user.email).at(-1)
      const link = new URLSearchParams(new URL(String(job?.data['url'])).hash.slice(1)).get('token')

      expect(
        await cacheControlOf('POST', ApiRoutes.auth.magicLinkConsume, { body: { token: link } })
      ).toBe('no-store')
      expect(await cacheControlOf('POST', ApiRoutes.auth.refresh, { body: { refreshToken } })).toBe(
        'no-store'
      )
      expect(await cacheControlOf('GET', ApiRoutes.auth.me, { token: accessToken })).toBe(
        'no-store'
      )
      expect(await cacheControlOf('GET', ApiRoutes.auth.sessions, { token: accessToken })).toBe(
        'no-store'
      )
    })

    it('does so when the answer is an error too, so a failure is not kept either', async () => {
      expect(
        await cacheControlOf('POST', ApiRoutes.auth.refresh, { body: { refreshToken: 'wrong' } })
      ).toBe('no-store')
    })
  })

  describe('authentication of the other routes', () => {
    it.each([
      ['POST', ApiRoutes.auth.logout],
      ['GET', ApiRoutes.auth.me],
      ['GET', ApiRoutes.auth.sessions],
      ['DELETE', ApiRoutes.auth.sessionById(randomUUID())]
    ])('%s %s demands an access token before anything else', async (method, path) => {
      const reply = await call(method, path)

      expect(reply.status).toBe(401)
      expect(errorCode(reply)).toBe('AUTH_UNAUTHORIZED')
    })

    it('refuses a token that does not verify', async () => {
      const reply = await call('GET', ApiRoutes.auth.me, { token: 'not.a.jwt' })

      expect(reply.status).toBe(401)
      expect(errorCode(reply)).toBe('AUTH_TOKEN_INVALID')
    })

    it('counts the flood against the throttler before the token check', async () => {
      const ip = freshIp()
      const statuses: number[] = []
      // Past the 100 of the default profile, with no token at all
      for (let i = 0; i < 101; i += 1) {
        statuses.push((await call('GET', ApiRoutes.auth.me, { ip })).status)
      }

      expect(statuses.slice(0, 100).every(status => status === 401)).toBe(true)
      expect(statuses[100]).toBe(429)
    })
  })

  describe('refresh', () => {
    it('rotates the token, and the old one then revokes the login', async () => {
      const { refreshToken, accessToken } = await login()

      const rotated = await call<{ refreshToken: string }>('POST', ApiRoutes.auth.refresh, {
        body: { refreshToken }
      })
      expect(rotated.status).toBe(200)
      expect(rotated.body.refreshToken).not.toBe(refreshToken)

      const replay = await call('POST', ApiRoutes.auth.refresh, { body: { refreshToken } })
      expect(replay.status).toBe(401)
      expect(errorCode(replay)).toBe('AUTH_REFRESH_TOKEN_REUSED')
      // The reuse took the whole family with it: the new token no longer works either
      const afterReuse = await call('POST', ApiRoutes.auth.refresh, {
        body: { refreshToken: rotated.body.refreshToken }
      })
      expect(afterReuse.status).toBe(401)
      expect(errorCode(afterReuse)).toBe('AUTH_TOKEN_INVALID')
      const active = await call('GET', ApiRoutes.auth.sessions, { token: accessToken })
      expect(active.body as unknown[]).toHaveLength(0)
    })

    it('rejects a body without the token', async () => {
      const reply = await call('POST', ApiRoutes.auth.refresh, { body: {} })

      expect(reply.status).toBe(400)
    })
  })

  describe('logout and the list of sessions', () => {
    it('logs out only the login of the token, and its refresh token stops working', async () => {
      const first = await login()
      // Another device of the same user, which must not notice
      const other = await test.sessions.issue(first.user, { userAgent: 'Other device' })

      const out = await call('POST', ApiRoutes.auth.logout, { token: first.accessToken })

      expect(out.status).toBe(EMPTY_BODY)
      const refresh = await call('POST', ApiRoutes.auth.refresh, {
        body: { refreshToken: first.refreshToken }
      })
      expect(refresh.status).toBe(401)
      expect(errorCode(refresh)).toBe('AUTH_TOKEN_INVALID')
      const stillLoggedIn = await call('POST', ApiRoutes.auth.refresh, {
        body: { refreshToken: other.refreshToken }
      })
      expect(stillLoggedIn.status).toBe(200)
    })

    it('can be repeated: a login that is already over stays over', async () => {
      const { accessToken } = await login()
      await call('POST', ApiRoutes.auth.logout, { token: accessToken })

      const again = await call('POST', ApiRoutes.auth.logout, { token: accessToken })

      expect(again.status).toBe(EMPTY_BODY)
    })

    it('lists the active logins marking the current one, and ends another on request', async () => {
      const { user, accessToken } = await login()
      // A second login of the same user, as from another device
      await test.sessions.issue(user, { userAgent: 'Other device' })

      const list = await call('GET', ApiRoutes.auth.sessions, { token: accessToken })

      expect(list.status).toBe(200)
      const sessions = list.body as Array<{
        id: string
        current: boolean
        userAgent: string
      }>
      expect(sessions).toHaveLength(2)
      expect(sessions.filter(item => item.current)).toHaveLength(1)
      const other = sessions.find(item => !item.current)
      expect(other?.userAgent).toBe('Other device')

      const revoked = await call('DELETE', ApiRoutes.auth.sessionById(other?.id ?? ''), {
        token: accessToken
      })
      expect(revoked.status).toBe(EMPTY_BODY)
      const after = await call('GET', ApiRoutes.auth.sessions, { token: accessToken })
      expect(after.body as unknown[]).toHaveLength(1)
    })

    it('answers 404 for the login of another user, as for one that does not exist', async () => {
      const mine = await login()
      const theirs = await login()
      const theirSession = (
        (await call('GET', ApiRoutes.auth.sessions, { token: theirs.accessToken })).body as Array<{
          id: string
        }>
      )[0]

      const foreign = await call('DELETE', ApiRoutes.auth.sessionById(theirSession?.id ?? ''), {
        token: mine.accessToken
      })
      const missing = await call('DELETE', ApiRoutes.auth.sessionById(randomUUID()), {
        token: mine.accessToken
      })

      expect(foreign.status).toBe(404)
      expect(missing.status).toBe(404)
      expect(errorCode(foreign)).toBe(errorCode(missing))
      const stillThere = await call('GET', ApiRoutes.auth.sessions, { token: theirs.accessToken })
      expect(stillThere.body as unknown[]).toHaveLength(1)
    })

    it('rejects an id that is not a uuid', async () => {
      const { accessToken } = await login()

      const reply = await call('DELETE', ApiRoutes.auth.sessionById('not-a-uuid'), {
        token: accessToken
      })

      expect(reply.status).toBe(400)
    })
  })

  describe('me', () => {
    it('answers 401 when the account is gone but the token has not expired', async () => {
      const { user, accessToken } = await login()
      await test.asOwner(client => client.query('DELETE FROM users WHERE id = $1', [user.id]))

      const reply = await call('GET', ApiRoutes.auth.me, { token: accessToken })

      expect(reply.status).toBe(401)
    })

    it('does not expose the internals of the account', async () => {
      const { accessToken } = await login()

      const reply = await call('GET', ApiRoutes.auth.me, { token: accessToken })

      expect(Object.keys(reply.body as object).sort()).toEqual(
        ['density', 'email', 'emailVerified', 'id', 'locale', 'name', 'timezone'].sort()
      )
    })
  })
})
