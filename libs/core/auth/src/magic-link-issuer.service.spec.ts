import type { Queue } from 'bullmq'

import { MAGIC_LINK_TTL_MINUTES } from '@platform/core/auth'
import { hashToken } from '@platform/core/crypto'
import { EmailTemplates, JobNames, type SendEmailJob } from '@platform/core/queues'

import { MagicLinkIssuer } from './magic-link-issuer.service'

interface Row {
  id: string
  email: string
  locale: string
  email_valid: boolean
}

function build(row?: Row) {
  const calls: string[] = []
  const created: { data: Record<string, unknown> }[] = []
  const tx = {
    $executeRaw: jest.fn(() => {
      calls.push('lock')
      return Promise.resolve(1)
    }),
    verificationToken: {
      deleteMany: jest.fn(() => {
        calls.push('void')
        return Promise.resolve({ count: 0 })
      }),
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        calls.push('save')
        created.push(args)
        return Promise.resolve({})
      })
    }
  }
  const prisma = {
    client: {
      $queryRaw: jest.fn(() => {
        calls.push('lookup')
        return Promise.resolve(row === undefined ? [] : [row])
      })
    },
    transaction: jest.fn(async (work: (t: typeof tx) => Promise<void>) => {
      await work(tx)
      calls.push('commit')
    })
  }
  const queue = {
    add: jest.fn((name: string, _data: SendEmailJob, _options: unknown) => {
      calls.push(`queue:${name}`)
      return Promise.resolve()
    })
  }
  const info = jest.fn()
  const issuer = new MagicLinkIssuer(
    prisma as never,
    queue as unknown as Queue<SendEmailJob>,
    { frontendUrl: 'https://app.example.com' },
    { setContext: jest.fn(), info }
  )
  return { issuer, calls, created, queue, tx, info }
}

const KNOWN: Row = { id: 'u1', email: 'Person@Example.com', locale: 'en', email_valid: true }

describe('MagicLinkIssuer', () => {
  it('looks up, locks the user, voids the old links, saves the new one, and only then queues the email', async () => {
    const { issuer, calls } = build(KNOWN)

    await issuer.issue('person@example.com')

    expect(calls).toEqual([
      'lookup',
      'lock',
      'void',
      'save',
      'commit',
      `queue:${JobNames.SEND_EMAIL}`
    ])
  })

  it('saves only the hash of the token, and puts the token in the fragment of the link', async () => {
    const { issuer, created, queue } = build(KNOWN)

    await issuer.issue('person@example.com', 'corr-1')

    const [name, job, options] = queue.add.mock.calls[0] ?? []
    expect(name).toBe(JobNames.SEND_EMAIL)
    const data = (job as SendEmailJob).data as { url: string; expiresInMinutes: number }
    const url = new URL(data.url)
    expect(url.origin).toBe('https://app.example.com')
    expect(url.search).toBe('')
    const token = new URLSearchParams(url.hash.slice(1)).get('token') ?? ''
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(created[0]?.data).toMatchObject({
      type: 'magic_link',
      tokenHash: hashToken(token),
      userId: 'u1',
      subject: 'Person@Example.com'
    })
    expect(JSON.stringify(created)).not.toContain(token)
    expect(job).toMatchObject({
      template: EmailTemplates.MAGIC_LINK,
      to: 'Person@Example.com',
      locale: 'en',
      correlationId: 'corr-1'
    })
    expect(data.expiresInMinutes).toBe(MAGIC_LINK_TTL_MINUTES)
    // The job holds the raw token: it must not stay in Redis once sent
    expect(options).toEqual({ removeOnComplete: true })
  })

  it('does not carry a correlation id it was not given, and falls back to the default language', async () => {
    const { issuer, queue } = build({ ...KNOWN, locale: 'xx' })

    await issuer.issue('person@example.com')

    const job = queue.add.mock.calls[0]?.[1]
    expect(job).not.toHaveProperty('correlationId')
    expect(job?.locale).toBe('es')
  })

  it('sets the expiry in the future by the time of the decision', async () => {
    const { issuer, created } = build(KNOWN)
    const before = Date.now()

    await issuer.issue('person@example.com')

    const expiresAt = (created[0]?.data['expiresAt'] as Date).getTime()
    expect(expiresAt).toBeGreaterThanOrEqual(before + MAGIC_LINK_TTL_MINUTES * 60_000 - 1000)
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + MAGIC_LINK_TTL_MINUTES * 60_000)
  })

  it.each([
    ['an address with no account', undefined],
    ['an address the provider reported as dead', { ...KNOWN, email_valid: false }]
  ])('saves and sends nothing for %s', async (_name, row) => {
    const { issuer, calls, info } = build(row)

    await issuer.issue('person@example.com')

    expect(calls).toEqual(['lookup'])
    expect(info).toHaveBeenCalledWith(
      { known: row !== undefined },
      'magic link requested: nothing to send'
    )
  })
})
