import { JwtService } from '@nestjs/jwt'

import { SessionRevokedReasons } from '@platform/core/auth'
import { hashToken } from '@platform/core/crypto'
import { PlatformException } from '@platform/core/errors'

import { type AuthTestApp, settings, startAuthTestApp } from '../../testing/auth-test-app'

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
  } catch (error) {
    return error instanceof PlatformException ? error.code : 'NOT_A_PLATFORM_EXCEPTION'
  }
  return undefined
}

describe('SessionService', () => {
  let test: AuthTestApp
  let jwt: JwtService

  beforeAll(async () => {
    test = await startAuthTestApp()
    jwt = test.app.get(JwtService)
  })
  afterAll(() => test.cleanUp())

  describe('issue', () => {
    it('opens a login: a signed access token, and a refresh token stored only as a hash', async () => {
      const user = await test.createUser()

      const issued = await test.sessions.issue(user, {
        userAgent: 'Firefox',
        ipAddress: '203.0.113.9'
      })

      const claims = jwt.verify<{ sub: string; sid: string; email: string }>(issued.accessToken)
      expect(claims).toMatchObject({ sub: user.id, email: user.email })
      expect(issued).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 })
      const rows = await test.asOwner(client =>
        client.query('SELECT * FROM sessions WHERE user_id = $1', [user.id])
      )
      expect(rows.rows).toHaveLength(1)
      expect(rows.rows[0]).toMatchObject({
        family_id: claims.sid,
        refresh_token_hash: hashToken(issued.refreshToken),
        user_agent: 'Firefox',
        ip_address: '203.0.113.9',
        consumed_at: null,
        revoked_at: null
      })
      expect(JSON.stringify(rows.rows)).not.toContain(issued.refreshToken) // The raw token is nowhere
      // In SQL: the column holds UTC without a zone, which the pg client would read as local time
      const lifetime = await test.asOwner(client =>
        client.query<{ seconds: number }>(
          `SELECT extract(epoch FROM (expires_at - (now() AT TIME ZONE 'UTC')))::int AS seconds
           FROM sessions WHERE user_id = $1`,
          [user.id]
        )
      )
      expect(lifetime.rows[0]?.seconds).toBeGreaterThan(settings.refreshTtlSeconds - 60)
      expect(lifetime.rows[0]?.seconds).toBeLessThanOrEqual(settings.refreshTtlSeconds)
    })

    it('keeps the user agent within its column', async () => {
      const user = await test.createUser()

      await test.sessions.issue(user, { userAgent: 'x'.repeat(1000) })

      const rows = await test.asOwner(client =>
        client.query<{ n: number }>(
          'SELECT length(user_agent) AS n FROM sessions WHERE user_id = $1',
          [user.id]
        )
      )
      expect(rows.rows[0]?.['n']).toBe(255)
    })

    it('leaves no session behind when the transaction it joined rolls back', async () => {
      const user = await test.createUser()

      await expect(
        test.prisma.transaction(async tx => {
          await test.sessions.issue(user, {}, tx)
          throw new Error('the rest of the unit of work failed')
        })
      ).rejects.toThrow('the rest of the unit of work failed')

      const rows = await test.asOwner(client =>
        client.query('SELECT 1 FROM sessions WHERE user_id = $1', [user.id])
      )
      expect(rows.rowCount).toBe(0)
    })
  })

  describe('refresh', () => {
    it('gives the next pair in the same family and marks the used token', async () => {
      const user = await test.createUser()
      const first = await test.sessions.issue(user)

      const second = await test.sessions.refresh(first.refreshToken)

      expect(second.refreshToken).not.toBe(first.refreshToken)
      const familyOf = (token: string): string => jwt.decode<{ sid: string }>(token).sid
      expect(familyOf(second.accessToken)).toBe(familyOf(first.accessToken))
      const rows = await test.asOwner(client =>
        client.query<{
          id: string
          consumed_at: Date | null
          replaced_by_id: string | null
        }>('SELECT * FROM sessions WHERE user_id = $1 ORDER BY created_at', [user.id])
      )
      expect(rows.rows).toHaveLength(2)
      expect(rows.rows[0]?.['consumed_at']).not.toBeNull()
      expect(rows.rows[0]?.['replaced_by_id']).toBe(rows.rows[1]?.['id'])
      expect(rows.rows[1]?.['consumed_at']).toBeNull()
    })

    it('goes on rotating along a chain of refreshes', async () => {
      const user = await test.createUser()
      let current = await test.sessions.issue(user)

      for (let i = 0; i < 5; i += 1) current = await test.sessions.refresh(current.refreshToken)

      expect(current.refreshToken).toBeDefined()
      const live = await test.sessions.listActive(user.id, '')
      expect(live).toHaveLength(1) // One login, however many times it rotated
    })

    it('revokes the whole family when a used token comes back, newest token included', async () => {
      const user = await test.createUser()
      const first = await test.sessions.issue(user)
      const second = await test.sessions.refresh(first.refreshToken)

      expect(await codeOf(test.sessions.refresh(first.refreshToken))).toBe(
        'AUTH_REFRESH_TOKEN_REUSED'
      )

      // The thief's copy and the user's newest token are both dead
      expect(await codeOf(test.sessions.refresh(second.refreshToken))).toBe('AUTH_TOKEN_INVALID')
      const rows = await test.asOwner(client =>
        client.query<{ revoked_at: Date | null; revoked_reason: string | null }>(
          'SELECT revoked_at, revoked_reason FROM sessions WHERE user_id = $1',
          [user.id]
        )
      )
      expect(rows.rows.every(row => row['revoked_at'] !== null)).toBe(true)
      expect(
        rows.rows.every(row => row['revoked_reason'] === SessionRevokedReasons.REUSE_DETECTED)
      ).toBe(true)
    })

    it('revokes only the family of the reuse, not the other logins of the user', async () => {
      const user = await test.createUser()
      const phone = await test.sessions.issue(user)
      const laptop = await test.sessions.issue(user)
      await test.sessions.refresh(laptop.refreshToken)

      await codeOf(test.sessions.refresh(laptop.refreshToken)) // The laptop token is replayed

      await expect(test.sessions.refresh(phone.refreshToken)).resolves.toBeDefined()
    })

    it('lets only one of two requests with the same token through, and revokes the login', async () => {
      const user = await test.createUser()
      const issued = await test.sessions.issue(user)

      const results = await Promise.allSettled([
        test.sessions.refresh(issued.refreshToken),
        test.sessions.refresh(issued.refreshToken)
      ])

      const winners = results.flatMap(result =>
        result.status === 'fulfilled' ? [result.value] : []
      )
      const losers = results.flatMap(result =>
        result.status === 'rejected' ? [result.reason as unknown] : []
      )
      expect(winners).toHaveLength(1)
      expect(losers).toHaveLength(1)
      expect(losers[0]).toMatchObject({ code: 'AUTH_REFRESH_TOKEN_REUSED', statusCode: 401 })
      // The login was revoked: not even the winner's new token works
      expect(await codeOf(test.sessions.refresh(winners[0]?.refreshToken ?? ''))).toBe(
        'AUTH_TOKEN_INVALID'
      )
    })

    it('still treats a used token as a leak once it has expired, and revokes the login', async () => {
      const user = await test.createUser()
      const first = await test.sessions.issue(user)
      const second = await test.sessions.refresh(first.refreshToken)
      await test.asOwner(client =>
        client.query(
          `UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE refresh_token_hash = $1`,
          [hashToken(first.refreshToken)]
        )
      )

      expect(await codeOf(test.sessions.refresh(first.refreshToken))).toBe(
        'AUTH_REFRESH_TOKEN_REUSED'
      )
      expect(await codeOf(test.sessions.refresh(second.refreshToken))).toBe('AUTH_TOKEN_INVALID')
    })

    it('records where each rotation came from, not only the first login', async () => {
      const user = await test.createUser()
      const first = await test.sessions.issue(user, {
        userAgent: 'Firefox',
        ipAddress: '203.0.113.1'
      })

      await test.sessions.refresh(first.refreshToken, {
        userAgent: 'Chrome',
        ipAddress: '198.51.100.2'
      })

      const [current] = await test.sessions.listActive(user.id, '')
      expect(current).toMatchObject({ userAgent: 'Chrome', ipAddress: '198.51.100.2' })
    })

    it('refuses an expired token with its own code', async () => {
      const user = await test.createUser()
      const issued = await test.sessions.issue(user)
      await test.asOwner(client =>
        client.query(
          `UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id = $1`,
          [user.id]
        )
      )

      expect(await codeOf(test.sessions.refresh(issued.refreshToken))).toBe('AUTH_TOKEN_EXPIRED')
    })

    it.each(['', 'not-a-token', 'x'.repeat(200)])(
      'refuses %j, which was never issued',
      async token => {
        expect(await codeOf(test.sessions.refresh(token))).toBe('AUTH_TOKEN_INVALID')
      }
    )

    it('refuses the token of a login that ended', async () => {
      const user = await test.createUser()
      const issued = await test.sessions.issue(user)
      const familyId = jwt.decode<{ sid: string }>(issued.accessToken).sid
      await test.sessions.logout(user.id, familyId)

      expect(await codeOf(test.sessions.refresh(issued.refreshToken))).toBe('AUTH_TOKEN_INVALID')
    })
  })

  describe('logout', () => {
    it('does not end the login of another user, even with its family id', async () => {
      const mine = await test.createUser()
      const theirs = await test.createUser()
      const issued = await test.sessions.issue(theirs)
      const theirFamily = jwt.decode<{ sid: string }>(issued.accessToken).sid

      await test.sessions.logout(mine.id, theirFamily)

      await expect(test.sessions.refresh(issued.refreshToken)).resolves.toBeDefined()
    })

    it('ends that login only, and can be repeated', async () => {
      const user = await test.createUser()
      const phone = await test.sessions.issue(user)
      const laptop = await test.sessions.issue(user)
      const laptopFamily = jwt.decode<{ sid: string }>(laptop.accessToken).sid

      await test.sessions.logout(user.id, laptopFamily)
      await test.sessions.logout(user.id, laptopFamily)

      expect(await codeOf(test.sessions.refresh(laptop.refreshToken))).toBe('AUTH_TOKEN_INVALID')
      await expect(test.sessions.refresh(phone.refreshToken)).resolves.toBeDefined()
    })
  })

  describe('the list of sessions', () => {
    it('shows each live login once, marks the current one, and leaves out the ended ones', async () => {
      const user = await test.createUser()
      const phone = await test.sessions.issue(user, { userAgent: 'Phone' })
      const laptop = await test.sessions.issue(user, { userAgent: 'Laptop' })
      const ended = await test.sessions.issue(user, { userAgent: 'Ended' })
      await test.sessions.logout(user.id, jwt.decode<{ sid: string }>(ended.accessToken).sid)
      const phoneFamily = jwt.decode<{ sid: string }>(phone.accessToken).sid
      expect(laptop.refreshToken).toBeDefined()

      const list = await test.sessions.listActive(user.id, phoneFamily)

      expect(list.map(item => item.userAgent).sort()).toEqual(['Laptop', 'Phone'])
      expect(list.find(item => item.userAgent === 'Phone')?.current).toBe(true)
      expect(list.find(item => item.userAgent === 'Laptop')?.current).toBe(false)
    })

    it('leaves out a login whose refresh token has expired', async () => {
      const user = await test.createUser()
      await test.sessions.issue(user, { userAgent: 'Old' })
      await test.sessions.issue(user, { userAgent: 'Recent' })
      await test.asOwner(client =>
        client.query(
          `UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id = $1 AND user_agent = 'Old'`,
          [user.id]
        )
      )

      const list = await test.sessions.listActive(user.id, '')

      expect(list.map(item => item.userAgent)).toEqual(['Recent'])
    })

    it('does not show the sessions of another user', async () => {
      const mine = await test.createUser()
      const theirs = await test.createUser()
      await test.sessions.issue(theirs)

      expect(await test.sessions.listActive(mine.id, '')).toEqual([])
    })

    it('lets a user end one of their logins', async () => {
      const user = await test.createUser()
      const issued = await test.sessions.issue(user)
      const familyId = jwt.decode<{ sid: string }>(issued.accessToken).sid

      await test.sessions.revokeOwn(user.id, familyId)

      expect(await codeOf(test.sessions.refresh(issued.refreshToken))).toBe('AUTH_TOKEN_INVALID')
      const rows = await test.asOwner(client =>
        client.query<{ revoked_reason: string | null }>(
          'SELECT revoked_reason FROM sessions WHERE user_id = $1',
          [user.id]
        )
      )
      expect(rows.rows[0]?.['revoked_reason']).toBe(SessionRevokedReasons.REVOKED_BY_USER)
    })

    it('answers "not found" for the login of another user, as for one that does not exist', async () => {
      const mine = await test.createUser()
      const theirs = await test.createUser()
      const issued = await test.sessions.issue(theirs)
      const theirFamily = jwt.decode<{ sid: string }>(issued.accessToken).sid

      expect(await codeOf(test.sessions.revokeOwn(mine.id, theirFamily))).toBe('RESOURCE_NOT_FOUND')
      expect(await codeOf(test.sessions.revokeOwn(mine.id, crypto.randomUUID()))).toBe(
        'RESOURCE_NOT_FOUND'
      )
      await expect(test.sessions.refresh(issued.refreshToken)).resolves.toBeDefined() // Untouched
    })
  })
})
