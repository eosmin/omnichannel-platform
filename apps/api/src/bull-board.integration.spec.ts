import { randomUUID } from 'node:crypto'

import { JwtService } from '@nestjs/jwt'

import { InfraRoutes } from '@platform/core/api'
import type { AccessTokenClaims } from '@platform/core/auth'
import { QueueNames } from '@platform/core/queues'

import { type AuthTestApp, settings, startAuthTestApp } from './testing/auth-test-app'

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')

// Bull Board mounted the way the api mounts it, with the real tokens, queues and Redis
describe('Bull Board', () => {
  let test: AuthTestApp
  let admin: { id: string; email: string }
  let member: { id: string; email: string }

  beforeAll(async () => {
    // The env writes the allowlist in lower case; the user's address has capitals
    const runId = randomUUID().slice(0, 8)
    const adminEmail = `it-${runId}-Admin@Example.com`
    test = await startAuthTestApp({ runId, bullBoardAdmins: [adminEmail.toLowerCase()] })
    admin = await test.createUser({ email: adminEmail })
    member = await test.createUser()
  })
  afterAll(() => test.cleanUp())

  function get(path: string, authorization?: string): Promise<Response> {
    return fetch(`${test.url}${path}`, {
      headers: { ...(authorization === undefined ? {} : { authorization }) }
    })
  }

  const tokenOf = async (user: { id: string; email: string }): Promise<string> =>
    (await test.sessions.issue(user)).accessToken

  it('is not mounted unless the flag asks for it', async () => {
    const off = await startAuthTestApp()
    try {
      const response = await fetch(`${off.url}/api/v1${InfraRoutes.queues}`)
      const plain = await fetch(`${off.url}${InfraRoutes.queues}`)
      expect([response.status, plain.status]).toEqual([404, 404])
    } finally {
      await off.cleanUp()
    }
  })

  it('answers 401 with the contract when there is no token', async () => {
    const response = await get(InfraRoutes.queues)

    expect(response.status).toBe(401)
    const body = (await response.json()) as { error: { code: string }; correlationId: string }
    expect(body.error.code).toBe('AUTH_UNAUTHORIZED')
    expect(body.correlationId).toBeDefined()
  })

  it('serves the board to a valid token whose email is on the allowlist, in any case', async () => {
    const response = await get(InfraRoutes.queues, `Bearer ${await tokenOf(admin)}`)

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('<html')
  })

  it('serves its api, which lists every queue of the platform', async () => {
    const response = await get(`${InfraRoutes.queues}/api/queues`, `Bearer ${await tokenOf(admin)}`)

    expect(response.status).toBe(200)
    const body = (await response.json()) as { queues: { name: string }[] }
    expect(body.queues.map(queue => queue.name).sort()).toEqual(Object.values(QueueNames).sort())
  })

  it('lets the page load its own scripts and styles, and nothing from outside', async () => {
    const response = await get(InfraRoutes.queues, `Bearer ${await tokenOf(admin)}`)

    const policy = response.headers.get('content-security-policy') ?? ''
    expect(policy).toContain("script-src 'self'")
    expect(policy).toContain("default-src 'none'")
    expect(policy).toContain("frame-ancestors 'none'")
    expect(policy).not.toMatch(/https?:|\*/) // No origin and no wildcard
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('keeps the strict policy of the api on a request the board refuses', async () => {
    const response = await get(InfraRoutes.queues)

    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'none';frame-ancestors 'none'"
    )
  })

  it('answers 403 to a valid token that is not on the allowlist', async () => {
    const response = await get(InfraRoutes.queues, `Bearer ${await tokenOf(member)}`)

    expect(response.status).toBe(403)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'PERMISSION_DENIED'
    )
  })

  it('does not let the api of the board be reached around the check', async () => {
    const paths = [
      `${InfraRoutes.queues}/api/queues`,
      `${InfraRoutes.queues}/`,
      `${InfraRoutes.queues}//api/queues`,
      `${InfraRoutes.queues.toUpperCase()}/api/queues`, // Express routes ignore the case
      `${InfraRoutes.queues}/api/queues?next=${InfraRoutes.queues}`
    ]
    for (const path of paths) {
      expect((await get(path)).status).toBe(401)
      expect((await get(path, `Bearer ${await tokenOf(member)}`)).status).toBe(403)
    }
  })

  it.each([
    ['a word that is not a token', 'Bearer nonsense'],
    ['another scheme', 'Basic YWRtaW46YWRtaW4='],
    ['an empty bearer', 'Bearer ']
  ])('refuses %s', async (_name, header) => {
    expect((await get(InfraRoutes.queues, header)).status).toBe(401)
  })

  describe('tokens that must not open it, even with the email of an admin', () => {
    const claims = (): AccessTokenClaims => ({
      sub: admin.id,
      sid: randomUUID(),
      email: admin.email
    })

    it('signed with another secret', async () => {
      const forged = await new JwtService({
        secret: 'another-secret-of-thirty-two-characters!!'
      }).signAsync(claims(), { expiresIn: 60 })

      expect((await get(InfraRoutes.queues, `Bearer ${forged}`)).status).toBe(401)
    })

    it('expired', async () => {
      const expired = await new JwtService({ secret: settings.jwtSecret }).signAsync(claims(), {
        expiresIn: -10
      })

      const response = await get(InfraRoutes.queues, `Bearer ${expired}`)

      expect(response.status).toBe(401)
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'AUTH_TOKEN_EXPIRED'
      )
    })

    it('with the algorithm none', async () => {
      const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...claims(), exp: 4_000_000_000 })}.`

      expect((await get(InfraRoutes.queues, `Bearer ${unsigned}`)).status).toBe(401)
    })

    it('signed with a different algorithm of the same secret', async () => {
      const hs512 = await new JwtService({
        secret: settings.jwtSecret,
        signOptions: { algorithm: 'HS512' }
      }).signAsync(claims(), { expiresIn: 60 })

      expect((await get(InfraRoutes.queues, `Bearer ${hs512}`)).status).toBe(401)
    })

    it('whose claims are not those of an access token', async () => {
      const odd = await new JwtService({ secret: settings.jwtSecret }).signAsync(
        { email: admin.email },
        { expiresIn: 60 }
      )

      const response = await get(InfraRoutes.queues, `Bearer ${odd}`)

      expect(response.status).toBe(401)
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'AUTH_TOKEN_INVALID'
      )
    })
  })

  it('lets nobody in when the allowlist is empty', async () => {
    const closed = await startAuthTestApp({ bullBoardAdmins: [] })
    try {
      const user = await closed.createUser()
      const token = (await closed.sessions.issue(user)).accessToken

      const response = await fetch(`${closed.url}${InfraRoutes.queues}`, {
        headers: { authorization: `Bearer ${token}` }
      })

      expect(response.status).toBe(403)
    } finally {
      await closed.cleanUp()
    }
  })
})
