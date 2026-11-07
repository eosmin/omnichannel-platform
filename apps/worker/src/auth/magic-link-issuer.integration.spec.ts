import { randomUUID } from 'node:crypto'

import { getQueueToken } from '@nestjs/bullmq'
import { Test, type TestingModule } from '@nestjs/testing'
import { PinoLogger } from 'nestjs-pino'
import pg from 'pg'

import { hashToken } from '@platform/core/crypto'
import { PrismaService } from '@platform/core/database'
import { connectionUrls } from '@platform/core/database-testing'
import { MagicLinkIssuer } from '@platform/core/magic-link-issuer'
import { DIGEST_LINKS } from '@platform/core/notifications'
import { EmailTemplates, JobNames, QueueNames } from '@platform/core/queues'

// The real issuer on the connection of the ROLE THE WORKER RUNS AS (platform_worker), not the api's:
// a grant that role lacks on `users` or `verification_tokens` would mean nobody gets a link, and no
// test that stubs the issuer or uses the api's role would see it.
describe('MagicLinkIssuer as the worker role', () => {
  let moduleRef: TestingModule
  let issuer: MagicLinkIssuer
  let owner: pg.Client
  const runId = randomUUID().slice(0, 8)
  const added: { name: string; data: Record<string, unknown>; options: unknown }[] = []
  const emailOf = (label: string) => `it-${runId}-${label}@example.com`

  async function createUser(email: string, emailValid = true): Promise<string> {
    const id = randomUUID()
    await owner.query(
      `INSERT INTO users (id, email, name, email_valid, locale, updated_at)
       VALUES ($1, $2, 'Test User', $3, 'en', now())`,
      [id, email, emailValid]
    )
    return id
  }
  const tokensOf = async (userId: string) =>
    (
      await owner.query<{ token_hash: string }>(
        'SELECT token_hash FROM verification_tokens WHERE user_id = $1',
        [userId]
      )
    ).rows

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      providers: [
        MagicLinkIssuer,
        {
          provide: PrismaService,
          useValue: new PrismaService({ databaseUrl: connectionUrls().worker })
        },
        {
          provide: getQueueToken(QueueNames.EMAIL),
          useValue: {
            add: (name: string, data: Record<string, unknown>, options: unknown) => {
              added.push({ name, data, options })
              return Promise.resolve()
            }
          }
        },
        { provide: DIGEST_LINKS, useValue: { frontendUrl: 'https://app.example.com' } },
        { provide: PinoLogger, useValue: { setContext: jest.fn(), info: jest.fn() } }
      ]
    }).compile()
    issuer = moduleRef.get(MagicLinkIssuer)
    owner = new pg.Client({ connectionString: connectionUrls().owner })
    await owner.connect()
  })

  afterAll(async () => {
    await owner.query('DELETE FROM users WHERE email LIKE $1', [`it-${runId}-%`])
    await owner.end()
    await moduleRef.get(PrismaService).onModuleDestroy?.()
    await moduleRef.close()
  })

  beforeEach(() => {
    added.length = 0
  })

  it('reads the user, saves the hashed link and queues the email', async () => {
    const email = emailOf('known')
    const userId = await createUser(email)

    await issuer.issue(email, 'corr-1')

    const rows = await tokensOf(userId)
    expect(rows).toHaveLength(1)
    expect(added).toHaveLength(1)
    const [job] = added
    expect(job?.name).toBe(JobNames.SEND_EMAIL)
    expect(job?.data).toMatchObject({
      template: EmailTemplates.MAGIC_LINK,
      to: email,
      locale: 'en',
      correlationId: 'corr-1'
    })
    const token = new URLSearchParams(
      new URL(String((job?.data['data'] as { url: string }).url)).hash.slice(1)
    ).get('token')
    expect(rows[0]?.token_hash).toBe(hashToken(token ?? ''))
  })

  it('voids the link before it when asked again (the delete is allowed to the worker role too)', async () => {
    const email = emailOf('again')
    const userId = await createUser(email)

    await issuer.issue(email)
    await issuer.issue(email)

    expect(await tokensOf(userId)).toHaveLength(1)
    expect(added).toHaveLength(2)
  })

  it('leaves exactly one live link when two requests for one user run together', async () => {
    const email = emailOf('parallel')
    const userId = await createUser(email)

    await Promise.all([issuer.issue(email), issuer.issue(email), issuer.issue(email)])

    expect(await tokensOf(userId)).toHaveLength(1)
  })

  it('saves and sends nothing for an unknown address or one marked dead', async () => {
    const dead = emailOf('dead')
    const deadId = await createUser(dead, false)

    await issuer.issue(emailOf('nobody'))
    await issuer.issue(dead)

    expect(added).toHaveLength(0)
    expect(await tokensOf(deadId)).toHaveLength(0)
  })
})
