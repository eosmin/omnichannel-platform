import { type Job, UnrecoverableError } from 'bullmq'
import { ZodError } from 'zod'

import type { EmailService } from '@platform/core/email'
import { Locales } from '@platform/core/i18n'
import type { MagicLinkIssuer } from '@platform/core/magic-link-issuer'
import {
  AuthEmailQueue,
  EmailTemplates,
  JobNames,
  type RequestMagicLinkJob
} from '@platform/core/queues'

import { AuthEmailProcessor } from './auth-email.processor'
import type { ProcessorSupport } from './processor-support'

const emailJob = {
  template: EmailTemplates.MAGIC_LINK,
  to: 'a@example.com',
  locale: Locales.ES,
  data: {},
  tags: { template: EmailTemplates.MAGIC_LINK }
}

function build() {
  const email = { send: jest.fn((_data: unknown) => Promise.resolve()) }
  const magicLinks = {
    issue: jest.fn((_email: string, _correlationId?: string) => Promise.resolve()),
    remainingValidityMs: jest.fn((_url: string) => Promise.resolve(0))
  }
  const support = { stale: jest.fn((_queue: string, _job: unknown, _reason: string) => undefined) }
  const processor = new AuthEmailProcessor(
    support as unknown as ProcessorSupport,
    email as unknown as EmailService,
    magicLinks as unknown as MagicLinkIssuer
  )
  const handle = (job: unknown) =>
    (processor as unknown as { handle(job: unknown): Promise<void> }).handle(job)
  return { email, magicLinks, support, handle }
}

describe('AuthEmailProcessor', () => {
  it.each([
    [JobNames.SEND_EMAIL, { template: 'magic-link', to: 'a@example.com' }],
    [JobNames.REQUEST_MAGIC_LINK, { email: 7 }]
  ])(
    'does not retry the %s job that does not fit, and says nothing of its data',
    async (name, data) => {
      const { email, magicLinks, handle } = build()

      const error: unknown = await handle({ name, data }).catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(UnrecoverableError)
      expect((error as Error).message).not.toContain('a@example')
      expect(email.send).not.toHaveBeenCalled()
      expect(magicLinks.issue).not.toHaveBeenCalled()
    }
  )

  it('hands a request for a magic link to the issuer, with its correlation id, and sends nothing itself', async () => {
    const { email, magicLinks, handle } = build()
    const job = {
      name: JobNames.REQUEST_MAGIC_LINK,
      data: { email: 'a@example.com', correlationId: 'corr' } satisfies RequestMagicLinkJob
    } as unknown as Job

    await handle(job)

    expect(magicLinks.issue).toHaveBeenCalledWith('a@example.com', 'corr')
    expect(email.send).not.toHaveBeenCalled()
  })

  it('sends the email of the link the issuer wrote', async () => {
    const { email, magicLinks, handle } = build()
    await handle({ name: JobNames.SEND_EMAIL, data: emailJob, attemptsMade: 0 })

    expect(email.send).toHaveBeenCalledWith(emailJob)
    expect(magicLinks.issue).not.toHaveBeenCalled()
  })

  it('does not retry a payload the template rejects', async () => {
    const { email, handle } = build()
    email.send.mockRejectedValueOnce(new ZodError([]))

    await expect(
      handle({ name: JobNames.SEND_EMAIL, data: emailJob, attemptsMade: 0 })
    ).rejects.toThrow(UnrecoverableError)
  })

  it('refuses a job it has no name for, and never reads an invitation delivery as an email', async () => {
    const { email, magicLinks, handle } = build()

    await expect(
      handle({ name: JobNames.DELIVER_INVITATION_EMAIL, data: { storeId: 's', invitationId: 'i' } })
    ).rejects.toThrow(UnrecoverableError)

    expect(email.send).not.toHaveBeenCalled()
    expect(magicLinks.issue).not.toHaveBeenCalled()
  })

  describe('a link mail that is tried again', () => {
    const link = {
      ...emailJob,
      data: { url: 'https://app.example.com/m#token=T', expiresInMinutes: 15 }
    }

    it('is not checked on its first attempt: the job is as fresh as the link', async () => {
      const { email, magicLinks, handle } = build()

      await handle({ name: JobNames.SEND_EMAIL, data: link, attemptsMade: 0 })

      expect(magicLinks.remainingValidityMs).not.toHaveBeenCalled()
      expect(email.send).toHaveBeenCalledWith(link)
    })

    it('is sent with the time that is left, not the time it said when it was queued', async () => {
      const { email, magicLinks, handle } = build()
      magicLinks.remainingValidityMs.mockResolvedValueOnce(4 * 60_000 + 30_000)

      await handle({ name: JobNames.SEND_EMAIL, data: link, attemptsMade: 3 })

      expect(magicLinks.remainingValidityMs).toHaveBeenCalledWith(link.data.url)
      expect(email.send).toHaveBeenCalledWith({
        ...link,
        data: { ...link.data, expiresInMinutes: 4 }
      })
    })

    it.each([0, AuthEmailQueue.MIN_LINK_VALIDITY_MS - 1])(
      'is dropped, not failed, when the link has %s ms left (used, replaced or about to expire)',
      async left => {
        const { email, magicLinks, support, handle } = build()
        magicLinks.remainingValidityMs.mockResolvedValueOnce(left)

        await expect(
          handle({ name: JobNames.SEND_EMAIL, data: link, attemptsMade: 2 })
        ).resolves.toBeUndefined()

        expect(email.send).not.toHaveBeenCalled()
        expect(support.stale).toHaveBeenCalledTimes(1)
        // The reason is all the note carries of the job: it names no link and no address
        expect(support.stale.mock.calls[0]?.[2]).toBe('the magic link is no longer live')
      }
    )

    it('is sent when the link has exactly the minimum left', async () => {
      const { email, magicLinks, handle } = build()
      magicLinks.remainingValidityMs.mockResolvedValueOnce(AuthEmailQueue.MIN_LINK_VALIDITY_MS)

      await handle({ name: JobNames.SEND_EMAIL, data: link, attemptsMade: 1 })

      expect(email.send).toHaveBeenCalledTimes(1)
    })

    it('is dropped when it carries no url to check', async () => {
      const { email, magicLinks, support, handle } = build()

      await handle({ name: JobNames.SEND_EMAIL, data: emailJob, attemptsMade: 1 })

      expect(email.send).not.toHaveBeenCalled()
      expect(magicLinks.remainingValidityMs).not.toHaveBeenCalled()
      expect(support.stale).toHaveBeenCalledTimes(1)
    })

    it('leaves a retry of another template alone', async () => {
      const { email, magicLinks, handle } = build()
      const other = { ...emailJob, template: EmailTemplates.INVITATION }

      await handle({ name: JobNames.SEND_EMAIL, data: other, attemptsMade: 4 })

      expect(magicLinks.remainingValidityMs).not.toHaveBeenCalled()
      expect(email.send).toHaveBeenCalledWith(other)
    })
  })
})

describe('AuthEmailProcessor, a failure that is not the provider', () => {
  it('says only the name of what failed when the mail cannot be sent', async () => {
    const ADDRESS = 'victim.person@example.com'
    const { email, handle } = build()
    email.send.mockRejectedValue(
      Object.assign(new Error(`template data for (${ADDRESS}) is broken`), { name: 'TypeError' })
    )

    const thrown: unknown = await handle({
      name: JobNames.SEND_EMAIL,
      attemptsMade: 0,
      data: emailJob
    }).catch((caught: unknown) => caught)

    expect((thrown as Error).message).toBe('the mail job failed: TypeError')
    expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown))).not.toContain(ADDRESS)
  })

  it('says only the name of what failed when the validity of the link cannot be read', async () => {
    const ADDRESS = 'victim.person@example.com'
    const { magicLinks, handle } = build()
    magicLinks.remainingValidityMs.mockRejectedValue(
      Object.assign(new Error(`lookup of (${ADDRESS}) failed`), {
        name: 'PrismaClientKnownRequestError'
      })
    )

    const thrown: unknown = await handle({
      name: JobNames.SEND_EMAIL,
      attemptsMade: 1,
      data: { ...emailJob, data: { url: 'https://x.example/m?t=1' } }
    }).catch((caught: unknown) => caught)

    expect((thrown as Error).message).toBe('the mail job failed: PrismaClientKnownRequestError')
  })
})
