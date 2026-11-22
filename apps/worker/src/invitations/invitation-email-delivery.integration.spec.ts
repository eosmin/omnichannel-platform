import { randomUUID } from 'node:crypto'

import { Test, type TestingModule } from '@nestjs/testing'
import type { PinoLogger } from 'nestjs-pino'
import pg from 'pg'

import { CredentialCipher } from '@platform/core/crypto'
import { JobContext, PrismaService } from '@platform/core/database'
import { connectionUrls } from '@platform/core/database-testing'
import {
  type EmailService,
  type InvitationEmail,
  InvitationOutbox,
  invitationRetryDelayMs,
  sealInvitationEmail
} from '@platform/core/email'
import { EmailTemplates } from '@platform/core/queues'

import { WorkerModule } from '../worker.module'

import { InvitationEmailDelivery } from './invitation-email-delivery.service'

const SECRET_URL = 'https://app.example.com/invitations/SECRET-TOKEN-VALUE'

// The outbox of the email of an invitation against the real database: what a dead queue, a double delivery, a failed provider and an
// invitation that was accepted half way do to it. The provider is a stand-in (what it was asked to send is what is checked).
describe('InvitationEmailDelivery', () => {
  let moduleRef: TestingModule
  let owner: pg.Client
  let cipher: CredentialCipher
  let delivery: InvitationEmailDelivery
  const send = jest.fn<Promise<void>, [InvitationEmail]>()
  const logged: unknown[] = []
  const organizationId = randomUUID()
  const storeId = randomUUID()
  const otherStoreId = randomUUID()
  const userId = randomUUID()
  const roleId = randomUUID()

  const logger = {
    setContext: () => undefined,
    warn: (...args: unknown[]) => logged.push(args),
    error: (...args: unknown[]) => logged.push(args),
    info: (...args: unknown[]) => logged.push(args)
  } as unknown as PinoLogger

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(PrismaService)
      .useValue(new PrismaService({ databaseUrl: connectionUrls().worker }))
      .compile()
    cipher = moduleRef.get(CredentialCipher, { strict: false })
    delivery = new InvitationEmailDelivery(
      moduleRef.get(PrismaService, { strict: false }),
      moduleRef.get(JobContext, { strict: false }),
      cipher,
      { send } as unknown as EmailService,
      logger
    )
    owner = new pg.Client({ connectionString: connectionUrls().owner })
    await owner.connect()
    const slug = `it-invite-${organizationId.slice(0, 8)}`
    await owner.query(
      `INSERT INTO organizations (id, name, slug, updated_at) VALUES ($1, $2, $2, now())`,
      [organizationId, slug]
    )
    for (const id of [storeId, otherStoreId]) {
      await owner.query(
        `INSERT INTO stores (id, organization_id, name, slug, updated_at) VALUES ($1, $2, $3, $3, now())`,
        [id, organizationId, `${slug}-${id.slice(0, 4)}`]
      )
    }
    await owner.query(
      `INSERT INTO users (id, email, name, updated_at) VALUES ($1, $2, 'inviter', now())`,
      [userId, `${slug}@example.com`]
    )
    await owner.query(
      `INSERT INTO roles (id, store_id, name, updated_at) VALUES ($1, $2, 'Role', now())`,
      [roleId, storeId]
    )
  })

  afterAll(async () => {
    await owner.query(`DELETE FROM organizations WHERE id = $1`, [organizationId])
    await owner.query(`DELETE FROM users WHERE id = $1`, [userId])
    await owner.end()
    await moduleRef.close()
  })

  beforeEach(() => {
    send.mockReset()
    send.mockResolvedValue(undefined)
    logged.length = 0
  })

  async function pending(
    overrides: {
      status?: string
      expiresAt?: Date
      createdAt?: Date
      attempts?: number
      claimedAt?: Date | null
      store?: string
    } = {}
  ): Promise<{ id: string; email: string }> {
    const id = randomUUID()
    const email = `${id.slice(0, 8)}@example.com`
    const sealed = sealInvitationEmail(cipher, {
      template: EmailTemplates.INVITATION,
      to: email,
      locale: 'en',
      data: {
        url: SECRET_URL,
        inviterName: 'inviter',
        storeName: 's',
        roleName: 'r',
        expiresInDays: 7
      },
      tags: { storeId, template: EmailTemplates.INVITATION }
    })
    await owner.query(
      `INSERT INTO invitations (id, organization_id, store_id, email, role_id, token_hash, status, invited_by_id, expires_at, created_at,
         email_outbox, email_attempts, email_claimed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        id,
        organizationId,
        overrides.store ?? storeId,
        email,
        roleId,
        `hash-${id}`,
        overrides.status ?? 'PENDING',
        userId,
        // As UTC text: the columns are `timestamp` without a zone, and the driver would write a Date in the local zone of the machine
        (overrides.expiresAt ?? new Date(Date.now() + 86_400_000)).toISOString(),
        (overrides.createdAt ?? new Date(Date.now() - 600_000)).toISOString(),
        Buffer.from(sealed),
        overrides.attempts ?? 0,
        overrides.claimedAt?.toISOString() ?? null
      ]
    )
    return { id, email }
  }

  async function state(id: string) {
    const { rows } = await owner.query<{
      email_outbox: Buffer | null
      email_attempts: number
      email_sent_at: Date | null
      email_claimed_at: Date | null
      // As epoch: the driver would read a `timestamp` without a zone in the local zone of the machine
      email_retry_ms: number | null
    }>(
      `SELECT email_outbox, email_attempts, email_sent_at, email_claimed_at,
              (extract(epoch FROM email_retry_at) * 1000)::float8 AS email_retry_ms FROM invitations WHERE id = $1`,
      [id]
    )
    const [row] = rows
    if (row === undefined) throw new Error('the invitation is gone')
    return row
  }

  it('sends the sealed email once and clears the outbox, keeping the sent time', async () => {
    const { id, email } = await pending()

    expect(await delivery.deliver(storeId, id)).toBe('sent')

    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[0]).toMatchObject({ to: email, data: { url: SECRET_URL } })
    const row = await state(id)
    expect(row.email_outbox).toBeNull()
    expect(row.email_sent_at).not.toBeNull()
    expect(row.email_claimed_at).toBeNull()
  })

  it('sends nothing the second time (a duplicate job, then the sweep)', async () => {
    const { id } = await pending()

    expect(await delivery.deliver(storeId, id)).toBe('sent')
    expect(await delivery.deliver(storeId, id)).toBe('skipped')

    expect(send).toHaveBeenCalledTimes(1)
  })

  it('sends once when two deliveries of the same row run at the same moment', async () => {
    const { id } = await pending()

    const results = await Promise.all([
      delivery.deliver(storeId, id),
      delivery.deliver(storeId, id)
    ])

    expect(results.sort()).toEqual(['sent', 'skipped'])
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('keeps the email when the provider fails, waits a backoff, and then sends it (the link is not lost)', async () => {
    const { id } = await pending()
    send.mockRejectedValueOnce(new Error(`provider down ${SECRET_URL}`))
    const failedAt = new Date()

    expect(await delivery.deliver(storeId, id, failedAt)).toBe('failed')
    const afterFailure = await state(id)
    expect(afterFailure.email_outbox).not.toBeNull()
    expect(afterFailure.email_claimed_at).toBeNull()
    expect(afterFailure.email_attempts).toBe(1)
    expect(afterFailure.email_retry_ms).toBe(failedAt.getTime() + invitationRetryDelayMs(1))

    // Not before the backoff: a minute-by-minute sweep must not burn the attempts of a provider that is down
    expect(await delivery.deliver(storeId, id, new Date(failedAt.getTime() + 1000))).toBe('skipped')
    expect(send).toHaveBeenCalledTimes(1)
    const later = new Date(failedAt.getTime() + invitationRetryDelayMs(1) + 1000)
    expect(await delivery.deliver(storeId, id, later)).toBe('sent')
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('doubles the backoff with every failed attempt, up to a cap', () => {
    expect(invitationRetryDelayMs(1)).toBe(InvitationOutbox.RETRY_BASE_MS)
    expect(invitationRetryDelayMs(2)).toBe(2 * InvitationOutbox.RETRY_BASE_MS)
    expect(invitationRetryDelayMs(30)).toBe(InvitationOutbox.RETRY_MAX_MS)
  })

  it('does not clear the outbox of a row whose last attempt another worker is sending right now', async () => {
    const { id } = await pending({ attempts: InvitationOutbox.MAX_ATTEMPTS, claimedAt: new Date() })

    expect(await delivery.deliver(storeId, id)).toBe('skipped')

    expect((await state(id)).email_outbox).not.toBeNull()
  })

  it('never writes the link, the token or the address to a log', async () => {
    const { id, email } = await pending()
    send.mockRejectedValueOnce(new Error(`provider down ${SECRET_URL} ${email}`))

    await delivery.deliver(storeId, id)

    const text = JSON.stringify(logged)
    expect(logged.length).toBeGreaterThan(0)
    expect(text).not.toContain('SECRET-TOKEN-VALUE')
    expect(text).not.toContain(email)
  })

  it('gives up after the last attempt: the outbox is cleared and nothing is sent', async () => {
    const { id } = await pending({ attempts: InvitationOutbox.MAX_ATTEMPTS })

    expect(await delivery.deliver(storeId, id)).toBe('skipped')

    expect(send).not.toHaveBeenCalled()
    expect((await state(id)).email_outbox).toBeNull()
  })

  it.each([['ACCEPTED'], ['REVOKED']])(
    'does not mail a link that is %s: it clears the outbox instead',
    async status => {
      const { id } = await pending({ status })

      expect(await delivery.deliver(storeId, id)).toBe('skipped')

      expect(send).not.toHaveBeenCalled()
      expect((await state(id)).email_outbox).toBeNull()
    }
  )

  it('does not mail an invitation that expired', async () => {
    const { id } = await pending({ expiresAt: new Date(Date.now() - 1000) })

    expect(await delivery.deliver(storeId, id)).toBe('skipped')

    expect(send).not.toHaveBeenCalled()
  })

  it('does not deliver an invitation of another store, even with its id', async () => {
    const { id } = await pending({ store: otherStoreId })

    expect(await delivery.deliver(storeId, id)).toBe('skipped')

    expect(send).not.toHaveBeenCalled()
    expect((await state(id)).email_outbox).not.toBeNull()
  })

  it('leaves a row under a live claim alone, and takes it again when the claim expired (a worker that died)', async () => {
    const live = await pending({ claimedAt: new Date() })
    const dead = await pending({
      claimedAt: new Date(Date.now() - InvitationOutbox.CLAIM_TTL_MS - 1000)
    })

    expect(await delivery.deliver(storeId, live.id)).toBe('skipped')
    expect(await delivery.deliver(storeId, dead.id)).toBe('sent')

    expect(send).toHaveBeenCalledTimes(1)
  })

  it('sweeps what waits, leaving the fresh rows to the job of the api', async () => {
    const old = await pending({ createdAt: new Date(Date.now() - 600_000) })
    const fresh = await pending({ createdAt: new Date() })

    await delivery.sweep()

    expect((await state(old.id)).email_outbox).toBeNull()
    expect((await state(fresh.id)).email_outbox).not.toBeNull()
  })
})
