import { JwtService } from '@nestjs/jwt'

import { REFRESH_REUSE_GRACE_SECONDS, SessionRevokedReasons } from '@platform/core/auth'
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

  // Makes a token that was just used look as if it was used `seconds` ago
  async function usedAgo(token: string, seconds: number): Promise<void> {
    await test.asOwner(client =>
      client.query(
        `UPDATE sessions SET consumed_at = now() AT TIME ZONE 'UTC' - make_interval(secs => $2)
         WHERE refresh_token_hash = $1`,
        [hashToken(token), seconds]
      )
    )
  }
  const pastGrace = REFRESH_REUSE_GRACE_SECONDS + 5

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
      await usedAgo(first.refreshToken, pastGrace)

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
      await usedAgo(laptop.refreshToken, pastGrace)

      await codeOf(test.sessions.refresh(laptop.refreshToken)) // The laptop token is replayed

      await expect(test.sessions.refresh(phone.refreshToken)).resolves.toBeDefined()
    })

    describe('grace window', () => {
      const rowsOf = (userId: string) =>
        test.asOwner(client =>
          client.query<{
            revoked_at: Date | null
            consumed_at: Date | null
            grace_used_at: Date | null
          }>('SELECT revoked_at, consumed_at, grace_used_at FROM sessions WHERE user_id = $1', [
            userId
          ])
        )

      it('lets two simultaneous requests with the same token both through and keeps the login', async () => {
        const user = await test.createUser()
        const issued = await test.sessions.issue(user)

        const results = await Promise.allSettled([
          test.sessions.refresh(issued.refreshToken),
          test.sessions.refresh(issued.refreshToken)
        ])

        const pairs = results.flatMap(r => (r.status === 'fulfilled' ? [r.value] : []))
        expect(pairs).toHaveLength(2)
        expect(pairs[0]?.refreshToken).not.toBe(pairs[1]?.refreshToken)
        const rows = await rowsOf(user.id)
        expect(rows.rows.every(row => row.revoked_at === null)).toBe(true)
        // Either pair keeps working
        await expect(test.sessions.refresh(pairs[0]?.refreshToken ?? '')).resolves.toBeDefined()
        await expect(test.sessions.refresh(pairs[1]?.refreshToken ?? '')).resolves.toBeDefined()
      })

      it('lets a used token come back once inside the window, as after a lost answer', async () => {
        const user = await test.createUser()
        const first = await test.sessions.issue(user)
        await test.sessions.refresh(first.refreshToken) // The answer never reached the browser
        await usedAgo(first.refreshToken, REFRESH_REUSE_GRACE_SECONDS - 5)

        const again = await test.sessions.refresh(first.refreshToken)

        const claims = jwt.decode<{ sid: string }>(again.accessToken)
        expect(claims.sid).toBe(jwt.decode<{ sid: string }>(first.accessToken).sid)
        const rows = await rowsOf(user.id)
        expect(rows.rowCount).toBe(3)
        expect(rows.rows.filter(row => row.grace_used_at !== null)).toHaveLength(1)
        expect(rows.rows.every(row => row.revoked_at === null)).toBe(true)
      })

      it('writes an audit entry and no secret when it grants the grace', async () => {
        const user = await test.createUser()
        const first = await test.sessions.issue(user)
        await test.sessions.refresh(first.refreshToken)

        await test.sessions.refresh(first.refreshToken, { ipAddress: '203.0.113.7' })

        // The entry is written in the background: wait for it
        const query = () =>
          test.asOwner(client =>
            client.query<{ metadata: unknown; ip_address: string | null }>(
              `SELECT metadata, ip_address FROM audit_logs WHERE action = 'user.session_refresh_grace' AND user_id = $1`,
              [user.id]
            )
          )
        let rows = await query()
        for (let i = 0; i < 50 && rows.rowCount === 0; i += 1) {
          await new Promise(resolve => setTimeout(resolve, 100))
          rows = await query()
        }
        expect(rows.rowCount).toBe(1)
        expect(rows.rows[0]?.ip_address).toBe('203.0.113.7')
        expect(JSON.stringify(rows.rows)).not.toContain(first.refreshToken)
      })

      it('revokes the login when the token comes back after the window', async () => {
        const user = await test.createUser()
        const first = await test.sessions.issue(user)
        const second = await test.sessions.refresh(first.refreshToken)
        await usedAgo(first.refreshToken, pastGrace)

        expect(await codeOf(test.sessions.refresh(first.refreshToken))).toBe(
          'AUTH_REFRESH_TOKEN_REUSED'
        )

        expect(await codeOf(test.sessions.refresh(second.refreshToken))).toBe('AUTH_TOKEN_INVALID')
        const rows = await rowsOf(user.id)
        expect(rows.rows.every(row => row.revoked_at !== null)).toBe(true)
      })

      it('gives the grace only once per token: the second time is a reuse', async () => {
        const user = await test.createUser()
        const first = await test.sessions.issue(user)
        await test.sessions.refresh(first.refreshToken)
        const graced = await test.sessions.refresh(first.refreshToken)

        expect(await codeOf(test.sessions.refresh(first.refreshToken))).toBe(
          'AUTH_REFRESH_TOKEN_REUSED'
        )

        expect(await codeOf(test.sessions.refresh(graced.refreshToken))).toBe('AUTH_TOKEN_INVALID')
      })

      it('gives no grace to another user agent: it is a reuse', async () => {
        const user = await test.createUser()
        const first = await test.sessions.issue(user, { userAgent: 'Firefox' })
        await test.sessions.refresh(first.refreshToken, { userAgent: 'Firefox' })

        expect(
          await codeOf(test.sessions.refresh(first.refreshToken, { userAgent: 'curl/8' }))
        ).toBe('AUTH_REFRESH_TOKEN_REUSED')

        const rows = await rowsOf(user.id)
        expect(rows.rows.every(row => row.revoked_at !== null)).toBe(true)
      })

      it('gives the grace to the same user agent from another address and records the change', async () => {
        const user = await test.createUser()
        const context = { userAgent: 'Firefox', ipAddress: '203.0.113.1' }
        const first = await test.sessions.issue(user, context)
        await test.sessions.refresh(first.refreshToken, context)

        await expect(
          test.sessions.refresh(first.refreshToken, { ...context, ipAddress: '198.51.100.9' })
        ).resolves.toBeDefined()

        const query = () =>
          test.asOwner(client =>
            client.query<{ metadata: { ipChanged: boolean } }>(
              `SELECT metadata FROM audit_logs WHERE action = 'user.session_refresh_grace' AND user_id = $1`,
              [user.id]
            )
          )
        let rows = await query()
        for (let i = 0; i < 50 && rows.rowCount === 0; i += 1) {
          await new Promise(resolve => setTimeout(resolve, 100))
          rows = await query()
        }
        expect(rows.rows[0]?.metadata.ipChanged).toBe(true)
      })

      it('shows one login, not two, in the list of sessions after a grace', async () => {
        const user = await test.createUser()
        const first = await test.sessions.issue(user)
        await test.sessions.refresh(first.refreshToken)
        await test.sessions.refresh(first.refreshToken) // The grace: two live tokens in the family

        const live = await test.sessions.listActive(user.id, '')

        expect(live).toHaveLength(1)
      })

      it('revokes the login at the third request with the same token: a known limit', async () => {
        const user = await test.createUser()
        const first = await test.sessions.issue(user)

        const results = await Promise.allSettled([
          test.sessions.refresh(first.refreshToken),
          test.sessions.refresh(first.refreshToken),
          test.sessions.refresh(first.refreshToken)
        ])

        // One rotates, one takes the grace, the third is a reuse. The web serializes the refreshes
        // (Web Lock), so three at once is not a case the browser produces.
        expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(2)
        const rows = await rowsOf(user.id)
        expect(rows.rows.every(row => row.revoked_at !== null)).toBe(true)
      })

      it('does not give the grace twice to two simultaneous requests on a used token', async () => {
        const user = await test.createUser()
        const first = await test.sessions.issue(user)
        await test.sessions.refresh(first.refreshToken)

        const results = await Promise.allSettled([
          test.sessions.refresh(first.refreshToken),
          test.sessions.refresh(first.refreshToken)
        ])

        expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
        const rejected = results.find(r => r.status === 'rejected')
        expect((rejected as PromiseRejectedResult).reason).toMatchObject({
          code: 'AUTH_REFRESH_TOKEN_REUSED'
        })
      })

      it('revokes the login when the successor was already used, even inside the window', async () => {
        const user = await test.createUser()
        const first = await test.sessions.issue(user)
        const second = await test.sessions.refresh(first.refreshToken)
        await test.sessions.refresh(second.refreshToken) // The login moved on

        expect(await codeOf(test.sessions.refresh(first.refreshToken))).toBe(
          'AUTH_REFRESH_TOKEN_REUSED'
        )

        const rows = await rowsOf(user.id)
        expect(rows.rows.every(row => row.revoked_at !== null)).toBe(true)
      })

      it('does not bring back a login that was ended, inside the window', async () => {
        const user = await test.createUser()
        const first = await test.sessions.issue(user)
        const second = await test.sessions.refresh(first.refreshToken)
        const family = jwt.decode<{ sid: string }>(second.accessToken).sid
        await test.sessions.logout(user.id, family)

        expect(await codeOf(test.sessions.refresh(first.refreshToken))).toBe('AUTH_TOKEN_INVALID')
        expect(await codeOf(test.sessions.refresh(second.refreshToken))).toBe('AUTH_TOKEN_INVALID')
      })

      it('does not give the grace past the end of the login', async () => {
        const user = await test.createUser()
        const first = await test.sessions.issue(user)
        await test.sessions.refresh(first.refreshToken)
        await test.asOwner(client =>
          client.query(
            `UPDATE sessions SET family_expires_at = now() - interval '1 minute' WHERE user_id = $1`,
            [user.id]
          )
        )

        expect(await codeOf(test.sessions.refresh(first.refreshToken))).toBe(
          'AUTH_REFRESH_TOKEN_REUSED'
        )
      })

      it('leaves the other logins of the user and the logins of others alone', async () => {
        const user = await test.createUser()
        const stranger = await test.createUser()
        const phone = await test.sessions.issue(user)
        const strangerLogin = await test.sessions.issue(stranger)
        const laptop = await test.sessions.issue(user)
        await test.sessions.refresh(laptop.refreshToken)
        await usedAgo(laptop.refreshToken, pastGrace)

        await codeOf(test.sessions.refresh(laptop.refreshToken)) // A reuse past the window

        await expect(test.sessions.refresh(phone.refreshToken)).resolves.toBeDefined()
        await expect(test.sessions.refresh(strangerLogin.refreshToken)).resolves.toBeDefined()
      })

      it('gives the pair of the grace to the owner of the token, not to anyone else', async () => {
        const user = await test.createUser()
        const stranger = await test.createUser()
        const first = await test.sessions.issue(user)
        await test.sessions.refresh(first.refreshToken)
        await test.sessions.issue(stranger)

        const again = await test.sessions.refresh(first.refreshToken)

        expect(jwt.decode<{ sub: string }>(again.accessToken).sub).toBe(user.id)
      })
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

  describe('the end of a login', () => {
    const UTC_NOW = `now() AT TIME ZONE 'UTC'` // The columns hold UTC without a zone

    interface Row {
      expires_at: Date
      family_expires_at: Date
      lifetime: number // Seconds from creation to the end of the family
      family_end_ms: number // In UTC: pg would read the column as local time
    }

    async function rowsOf(userId: string): Promise<Row[]> {
      const result = await test.asOwner(client =>
        client.query<Row>(
          `SELECT expires_at, family_expires_at,
                  extract(epoch FROM (family_expires_at - created_at))::int AS lifetime,
                  (extract(epoch FROM family_expires_at) * 1000)::float8 AS family_end_ms
           FROM sessions WHERE user_id = $1 ORDER BY created_at`,
          [userId]
        )
      )
      return result.rows
    }

    it('is fixed when the login starts: the cap after SESSION_MAX_AGE', async () => {
      const user = await test.createUser()

      await test.sessions.issue(user)

      const [row] = await rowsOf(user.id)
      expect(Math.abs((row?.lifetime ?? 0) - settings.sessionMaxAgeSeconds)).toBeLessThan(5)
    })

    it('does not move when the token is refreshed: every row of the family has the same end', async () => {
      const user = await test.createUser()
      const first = await test.sessions.issue(user)
      const second = await test.sessions.refresh(first.refreshToken)
      await test.sessions.refresh(second.refreshToken)

      const rows = await rowsOf(user.id)

      expect(rows).toHaveLength(3)
      const ends = new Set(rows.map(row => row.family_expires_at.getTime()))
      expect(ends.size).toBe(1)
    })

    it('stops a refresh token at the end of the login, even if it would last longer', async () => {
      const user = await test.createUser()
      const first = await test.sessions.issue(user)
      // The login has one day left, and a refresh token lasts seven
      await test.asOwner(client =>
        client.query(
          `UPDATE sessions SET family_expires_at = ${UTC_NOW} + interval '1 day' WHERE user_id = $1`,
          [user.id]
        )
      )

      const second = await test.sessions.refresh(first.refreshToken)

      const rows = await rowsOf(user.id)
      const next = rows[1]
      expect(next?.expires_at.getTime()).toBe(next?.family_expires_at.getTime())
      expect(new Date(second.refreshExpiresAt).getTime()).toBe(next?.family_end_ms)
      expect(new Date(second.refreshExpiresAt).getTime() - Date.now()).toBeLessThan(
        86_400_000 + 5000
      )
    })

    it('keeps the normal lifetime of the token while the login has more than that left', async () => {
      const user = await test.createUser()
      const first = await test.sessions.issue(user)

      const second = await test.sessions.refresh(first.refreshToken)

      const remaining = (new Date(second.refreshExpiresAt).getTime() - Date.now()) / 1000
      expect(Math.abs(remaining - settings.refreshTtlSeconds)).toBeLessThan(5)
    })

    it('refuses a refresh after the end of the login, with the code of an expired token', async () => {
      const user = await test.createUser()
      const issued = await test.sessions.issue(user)
      // The token itself still has days to live; the login does not
      await test.asOwner(client =>
        client.query(
          `UPDATE sessions SET family_expires_at = ${UTC_NOW} - interval '1 second' WHERE user_id = $1`,
          [user.id]
        )
      )

      expect(await codeOf(test.sessions.refresh(issued.refreshToken))).toBe('AUTH_TOKEN_EXPIRED')
      expect(await rowsOf(user.id)).toHaveLength(1) // No new token was issued
    })

    it('ends every refresh token of the family together, not only the newest', async () => {
      const user = await test.createUser()
      const first = await test.sessions.issue(user)
      const second = await test.sessions.refresh(first.refreshToken)
      await test.asOwner(client =>
        client.query(
          `UPDATE sessions SET family_expires_at = ${UTC_NOW} - interval '1 second' WHERE user_id = $1`,
          [user.id]
        )
      )

      expect(await codeOf(test.sessions.refresh(second.refreshToken))).toBe('AUTH_TOKEN_EXPIRED')
    })

    it('leaves a login out of the list once its end has passed, even if its token has not expired', async () => {
      const user = await test.createUser()
      const issued = await test.sessions.issue(user)
      const familyId = jwt.decode<{ sid: string }>(issued.accessToken).sid
      expect(await test.sessions.listActive(user.id, familyId)).toHaveLength(1)
      await test.asOwner(client =>
        client.query(
          `UPDATE sessions SET family_expires_at = ${UTC_NOW} - interval '1 second' WHERE user_id = $1`,
          [user.id]
        )
      )

      expect(await test.sessions.listActive(user.id, familyId)).toHaveLength(0)
    })

    it('does not touch another login of the same user', async () => {
      const user = await test.createUser()
      const old = await test.sessions.issue(user)
      const other = await test.sessions.issue(user)
      const familyOf = (token: string): string => jwt.decode<{ sid: string }>(token).sid
      await test.asOwner(client =>
        client.query(
          `UPDATE sessions SET family_expires_at = ${UTC_NOW} - interval '1 second' WHERE family_id = $1`,
          [familyOf(old.accessToken)]
        )
      )

      expect(await codeOf(test.sessions.refresh(old.refreshToken))).toBe('AUTH_TOKEN_EXPIRED')
      await expect(test.sessions.refresh(other.refreshToken)).resolves.toBeDefined()
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
