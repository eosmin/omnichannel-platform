import { type PinoLogger } from 'nestjs-pino'

import { type AuthTestApp, startAuthTestApp } from '../../testing/auth-test-app'

import { EmailValidityService } from './email-validity.service'

describe('EmailValidityService', () => {
  let test: AuthTestApp
  let service: EmailValidityService

  beforeAll(async () => {
    test = await startAuthTestApp()
    service = new EmailValidityService(test.prisma, {
      setContext: jest.fn(),
      warn: jest.fn()
    } as unknown as PinoLogger)
  })
  afterAll(() => test.cleanUp())

  async function validOf(id: string): Promise<boolean> {
    const rows = await test.asOwner(client =>
      client.query<{ email_valid: boolean }>('SELECT email_valid FROM users WHERE id = $1', [id])
    )
    return rows.rows[0]?.email_valid ?? true
  }

  it('invalidates the user whatever the case the provider echoes, and only that user', async () => {
    const hit = await test.createUser({ email: `it-${test.runId}-Mixed@Example.com` })
    const other = await test.createUser()

    const updated = await service.markInvalid([hit.email.toUpperCase()])

    expect(updated).toBe(1)
    expect(await validOf(hit.id)).toBe(false)
    expect(await validOf(other.id)).toBe(true)
  })

  it('does not treat % or _ in an address as wildcards', async () => {
    const victim = await test.createUser()

    // Same length as the real address with its first character replaced: with LIKE it would match
    const oneOff = victim.email.replace(/^./, '_')

    const updated = await service.markInvalid(['%', oneOff])

    expect(updated).toBe(0)
    expect(await validOf(victim.id)).toBe(true)
  })

  it('stops the magic link for that user', async () => {
    const user = await test.createUser()
    await service.markInvalid([user.email])

    await test.magicLinks.request(user.email)

    expect((await test.emailJobs()).filter(job => job.to === user.email)).toHaveLength(0)
  })

  it('changes nothing for an address that is no user, and for an empty list', async () => {
    expect(await service.markInvalid(['nobody@example.com'])).toBe(0)
    expect(await service.markInvalid([])).toBe(0)
  })

  it('counts a user once: a second report finds it already invalid', async () => {
    const user = await test.createUser()

    expect(await service.markInvalid([user.email])).toBe(1)
    expect(await service.markInvalid([user.email])).toBe(0)
  })
})
