import { JwtService } from '@nestjs/jwt'

import { MAGIC_LINK_TTL_MINUTES } from '@platform/core/auth'
import { hashToken } from '@platform/core/crypto'
import { PlatformException } from '@platform/core/errors'
import { EmailTemplates, type SendEmailJob } from '@platform/core/queues'

import { type AuthTestApp, FRONTEND_URL, startAuthTestApp } from '../../testing/auth-test-app'

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
  } catch (error) {
    return error instanceof PlatformException ? error.code : 'NOT_A_PLATFORM_EXCEPTION'
  }
  return undefined
}

// The raw token of the last link queued for an address, read out of the email job like the
// recipient reads it out of the email
function tokenFrom(url: string): string {
  const fragment = new URL(url).hash.slice(1)
  return new URLSearchParams(fragment).get('token') ?? ''
}

describe('MagicLinkService', () => {
  let test: AuthTestApp

  beforeAll(async () => {
    test = await startAuthTestApp()
  })
  afterAll(() => test.cleanUp())

  async function linkSentTo(email: string): Promise<string> {
    const jobs = (await test.emailJobs()).filter(job => job.to === email)
    const last = jobs.at(-1)
    return tokenFrom(String(last?.data['url']))
  }

  describe('request', () => {
    it('saves the link as a hash that expires in the time of the decision, and queues the email', async () => {
      const user = await test.createUser({ locale: 'en' })

      await test.magicLinks.request(user.email)

      const rows = await test.asOwner(client =>
        client.query<{ token_hash: string; seconds: number }>(
          `SELECT token_hash, type, subject, used_at,
                  extract(epoch FROM (expires_at - (now() AT TIME ZONE 'UTC')))::int AS seconds
           FROM verification_tokens WHERE user_id = $1`,
          [user.id]
        )
      )
      expect(rows.rows).toHaveLength(1)
      expect(rows.rows[0]).toMatchObject({ type: 'magic_link', subject: user.email, used_at: null })
      expect(rows.rows[0]?.['seconds']).toBeGreaterThan(MAGIC_LINK_TTL_MINUTES * 60 - 30)
      expect(rows.rows[0]?.['seconds']).toBeLessThanOrEqual(MAGIC_LINK_TTL_MINUTES * 60)

      const [job] = (await test.emailJobs()).filter(queued => queued.to === user.email)
      expect(job).toMatchObject({
        template: EmailTemplates.MAGIC_LINK,
        locale: 'en',
        tags: { template: EmailTemplates.MAGIC_LINK }
      })
      const token = await linkSentTo(user.email)
      expect(rows.rows[0]?.['token_hash']).toBe(hashToken(token)) // The email has what only the hash proves
      expect(JSON.stringify(rows.rows)).not.toContain(token) // The raw token is not in the database
    })

    it('puts the token in the fragment of the link, never in the query', async () => {
      const user = await test.createUser()

      await test.magicLinks.request(user.email)

      const [job] = (await test.emailJobs()).filter(queued => queued.to === user.email)
      const url = new URL(String(job?.data['url']))
      expect(url.origin).toBe(FRONTEND_URL)
      expect(url.pathname).toBe('/login/verify')
      expect(url.search).toBe('')
      expect(url.hash).toMatch(/^#token=[A-Za-z0-9_-]{43}$/)
    })

    it('falls back to the default language when the user has one we do not write in', async () => {
      const user = await test.createUser({ locale: 'xx' })

      await test.magicLinks.request(user.email)

      const [job] = (await test.emailJobs()).filter(queued => queued.to === user.email)
      expect(job?.locale).toBe('es')
    })

    it('finds the user whatever the case of the address', async () => {
      const user = await test.createUser({ email: `it-${test.runId}-MiXeD@Example.com` })

      await test.magicLinks.request(`  it-${test.runId}-mixed@example.COM `)

      expect((await test.emailJobs()).filter(job => job.to === user.email)).toHaveLength(1)
    })

    it.each([
      ['an underscore', (email: string) => email.replace(/.@/, '_@')],
      ['a percent sign', (email: string) => email.replace(/^[^@]+/, '%')],
      ['a bare wildcard domain', () => '%@example.com']
    ])('does not read %s of the address as a wildcard', async (_name, probeFor) => {
      // Several accounts of this run would match the pattern: whichever one it reached, nothing
      // may go out, to anyone, and no link may be saved
      const victim = await test.createUser()
      await test.createUser()
      const countTokens = async (): Promise<number> =>
        (
          await test.asOwner(client =>
            client.query('SELECT 1 FROM verification_tokens WHERE subject LIKE $1', [
              `it-${test.runId}-%`
            ])
          )
        ).rowCount ?? 0
      const queuedBefore = (await test.emailJobs()).length
      const tokensBefore = await countTokens()

      const probe = probeFor(victim.email)
      await test.forgetEmailLimit(probe.trim().toLowerCase())
      await test.magicLinks.request(probe)

      expect(await test.emailJobs()).toHaveLength(queuedBefore)
      expect(await countTokens()).toBe(tokensBefore)
    })

    it('does not keep the link in Redis once the email has gone out', async () => {
      const user = await test.createUser()

      await test.magicLinks.request(user.email)

      const jobs = await test.emailQueue.getJobs(['waiting', 'delayed', 'active'])
      const job = jobs.find(queued => (queued.data as SendEmailJob).to === user.email)
      expect(job?.opts.removeOnComplete).toBe(true) // A completed job would hold the token for 24 hours
    })

    it('answers the same, sending nothing, for an address with no account', async () => {
      const email = `it-${test.runId}-nobody@example.com`

      await expect(test.magicLinks.request(email)).resolves.toBeUndefined()

      expect((await test.emailJobs()).filter(job => job.to === email)).toHaveLength(0)
      const rows = await test.asOwner(client =>
        client.query('SELECT 1 FROM verification_tokens WHERE subject = $1', [email])
      )
      expect(rows.rowCount).toBe(0)
    })

    it('sends nothing to an address the provider reported as dead', async () => {
      const user = await test.createUser({ emailValid: false })

      await expect(test.magicLinks.request(user.email)).resolves.toBeUndefined()

      expect((await test.emailJobs()).filter(job => job.to === user.email)).toHaveLength(0)
      const rows = await test.asOwner(client =>
        client.query('SELECT 1 FROM verification_tokens WHERE user_id = $1', [user.id])
      )
      expect(rows.rowCount).toBe(0)
    })

    it('voids the links not used yet when another is asked for: asking again is the resend', async () => {
      const user = await test.createUser()
      await test.magicLinks.request(user.email)
      const first = await linkSentTo(user.email)
      await test.magicLinks.request(user.email)
      const second = await linkSentTo(user.email)

      expect(second).not.toBe(first)
      expect(await codeOf(test.magicLinks.consume(first))).toBe('AUTH_TOKEN_INVALID')
      await expect(test.magicLinks.consume(second)).resolves.toBeDefined()
    })

    it('refuses the sixth request for the same address within the window, known or not', async () => {
      const known = await test.createUser()
      const unknown = `it-${test.runId}-ghost@example.com`

      for (const email of [known.email, unknown]) {
        for (let i = 0; i < 5; i += 1) await test.magicLinks.request(email)
        // Both are refused alike: the limit does not reveal which of them has an account
        expect(await codeOf(test.magicLinks.request(email))).toBe('RATE_LIMIT_EXCEEDED')
      }
    })

    it('counts an address the same whatever its case or spaces', async () => {
      const email = `it-${test.runId}-casing@example.com`

      for (let i = 0; i < 5; i += 1) {
        await test.magicLinks.request(i % 2 === 0 ? email : ` ${email.toUpperCase()} `)
      }

      expect(await codeOf(test.magicLinks.request(email))).toBe('RATE_LIMIT_EXCEEDED')
    })
  })

  describe('consume', () => {
    it('opens a session, verifies the email and uses up the link', async () => {
      const user = await test.createUser()
      await test.magicLinks.request(user.email)
      const token = await linkSentTo(user.email)

      const result = await test.magicLinks.consume(token, { userAgent: 'Firefox' })

      const claims = test.app.get(JwtService).verify<{ sub: string }>(result.session.accessToken)
      expect(claims.sub).toBe(user.id)
      expect(result.user).toMatchObject({ id: user.id, email: user.email })
      const rows = await test.asOwner(async client => ({
        user: await client.query<{ email_verified: boolean }>(
          'SELECT email_verified FROM users WHERE id = $1',
          [user.id]
        ),
        tokens: await client.query<{ used_at: Date | null }>(
          'SELECT used_at FROM verification_tokens WHERE user_id = $1',
          [user.id]
        ),
        sessions: await client.query<{ user_agent: string | null }>(
          'SELECT user_agent FROM sessions WHERE user_id = $1',
          [user.id]
        )
      }))
      expect(rows.user.rows[0]?.['email_verified']).toBe(true)
      expect(rows.tokens.rows[0]?.['used_at']).not.toBeNull()
      expect(rows.sessions.rows).toEqual([{ user_agent: 'Firefox' }])
    })

    it('does not work a second time', async () => {
      const user = await test.createUser()
      await test.magicLinks.request(user.email)
      const token = await linkSentTo(user.email)
      await test.magicLinks.consume(token)

      expect(await codeOf(test.magicLinks.consume(token))).toBe('AUTH_TOKEN_INVALID')
    })

    it('opens one session only when the same link arrives twice at the same time', async () => {
      const user = await test.createUser()
      await test.magicLinks.request(user.email)
      const token = await linkSentTo(user.email)

      const results = await Promise.allSettled([
        test.magicLinks.consume(token),
        test.magicLinks.consume(token),
        test.magicLinks.consume(token)
      ])

      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      const rows = await test.asOwner(client =>
        client.query('SELECT 1 FROM sessions WHERE user_id = $1', [user.id])
      )
      expect(rows.rowCount).toBe(1)
    })

    it('refuses the request that read the link as unused but lost the claim to another', async () => {
      const user = await test.createUser()
      await test.magicLinks.request(user.email)
      const token = await linkSentTo(user.email)
      const staleRead = await test.prisma.client.verificationToken.findFirst({
        where: { tokenHash: hashToken(token) },
        include: { user: { select: { id: true, email: true, name: true } } }
      })
      await test.magicLinks.consume(token) // The other request wins
      // What the slower one saw before the winner committed: the link, still unused
      const reader = jest
        .spyOn(test.prisma.client.verificationToken, 'findFirst')
        .mockResolvedValueOnce(staleRead) // The row has the shape the service asks for
      try {
        expect(await codeOf(test.magicLinks.consume(token))).toBe('AUTH_TOKEN_INVALID')
      } finally {
        reader.mockRestore()
      }
      const rows = await test.asOwner(client =>
        client.query('SELECT 1 FROM sessions WHERE user_id = $1', [user.id])
      )
      expect(rows.rowCount).toBe(1) // Only the winner has a session
    })

    it('refuses an expired link with its own code', async () => {
      const user = await test.createUser()
      await test.magicLinks.request(user.email)
      const token = await linkSentTo(user.email)
      await test.asOwner(client =>
        client.query(
          `UPDATE verification_tokens SET expires_at = now() - interval '1 second' WHERE user_id = $1`,
          [user.id]
        )
      )

      expect(await codeOf(test.magicLinks.consume(token))).toBe('AUTH_TOKEN_EXPIRED')
    })

    it('keeps answering "invalid", not "expired", for a link that was used and then ran out', async () => {
      const user = await test.createUser()
      await test.magicLinks.request(user.email)
      const token = await linkSentTo(user.email)
      await test.magicLinks.consume(token)
      await test.asOwner(client =>
        client.query(
          `UPDATE verification_tokens SET expires_at = now() - interval '1 second' WHERE user_id = $1`,
          [user.id]
        )
      )

      expect(await codeOf(test.magicLinks.consume(token))).toBe('AUTH_TOKEN_INVALID')
    })

    it.each(['', 'nope', 'A'.repeat(43)])('refuses %j, which was never issued', async token => {
      expect(await codeOf(test.magicLinks.consume(token))).toBe('AUTH_TOKEN_INVALID')
    })

    it('refuses a token that is not a login link, even with the right secret', async () => {
      const user = await test.createUser()
      const secret = 'dsr-secret-that-someone-learned'
      await test.asOwner(client =>
        client.query(
          `INSERT INTO verification_tokens (id, type, token_hash, user_id, subject, expires_at)
           VALUES (gen_random_uuid(), 'dsr_verification', $1, $2, $3, now() + interval '1 day')`,
          [hashToken(secret), user.id, user.email]
        )
      )

      expect(await codeOf(test.magicLinks.consume(secret))).toBe('AUTH_TOKEN_INVALID')
    })

    it('voids the other links of the user once one is used', async () => {
      const user = await test.createUser()
      await test.magicLinks.request(user.email)
      const token = await linkSentTo(user.email)
      await test.asOwner(client =>
        client.query(
          `INSERT INTO verification_tokens (id, type, token_hash, user_id, subject, expires_at)
           VALUES (gen_random_uuid(), 'magic_link', $1, $2, $3, now() + interval '1 day')`,
          [hashToken('another-link'), user.id, user.email]
        )
      )

      await test.magicLinks.consume(token)

      expect(await codeOf(test.magicLinks.consume('another-link'))).toBe('AUTH_TOKEN_INVALID')
    })

    it('leaves the link usable and the email unverified when the session cannot be opened', async () => {
      const user = await test.createUser()
      await test.magicLinks.request(user.email)
      const token = await linkSentTo(user.email)
      const issue = jest
        .spyOn(test.sessions, 'issue')
        .mockRejectedValueOnce(new Error('database hiccup'))

      await expect(test.magicLinks.consume(token)).rejects.toThrow('database hiccup')
      issue.mockRestore()

      const rows = await test.asOwner(async client => ({
        user: await client.query<{ email_verified: boolean }>(
          'SELECT email_verified FROM users WHERE id = $1',
          [user.id]
        ),
        token: await client.query<{ used_at: Date | null }>(
          'SELECT used_at FROM verification_tokens WHERE user_id = $1',
          [user.id]
        )
      }))
      expect(rows.user.rows[0]?.['email_verified']).toBe(false)
      expect(rows.token.rows[0]?.['used_at']).toBeNull()
      await expect(test.magicLinks.consume(token)).resolves.toBeDefined() // The user can try again
    })

    it('does not tell an unknown link from a used one', async () => {
      const user = await test.createUser()
      await test.magicLinks.request(user.email)
      const token = await linkSentTo(user.email)
      await test.magicLinks.consume(token)

      const used = await test.magicLinks.consume(token).catch((error: unknown) => error)
      const unknown = await test.magicLinks.consume('A'.repeat(43)).catch((error: unknown) => error)

      expect(used).toBeInstanceOf(PlatformException)
      expect(unknown).toBeInstanceOf(PlatformException)
      expect((used as PlatformException).code).toBe((unknown as PlatformException).code)
      expect((used as PlatformException).message).toBe((unknown as PlatformException).message)
    })
  })
})
