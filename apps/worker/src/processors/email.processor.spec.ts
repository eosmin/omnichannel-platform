import { type Job, UnrecoverableError } from 'bullmq'
import type { PinoLogger } from 'nestjs-pino'
import { ZodError } from 'zod'

import { CredentialCipher, parseEncryptionKey } from '@platform/core/crypto'
import { EmailDeliveryError, type EmailService, sealMailJob } from '@platform/core/email'
import { Locales } from '@platform/core/i18n'
import type { MagicLinkIssuer } from '@platform/core/magic-link-issuer'
import { EmailTemplates, JobNames, type RequestMagicLinkJob } from '@platform/core/queues'

import type { DsrNoticeLedger } from '../compliance/dsr-notice-ledger.service'
import type { InvitationEmailDelivery } from '../invitations/invitation-email-delivery.service'

import { EmailProcessor } from './email.processor'
import type { ProcessorSupport } from './processor-support'

const cipher = new CredentialCipher(parseEncryptionKey('c'.repeat(64)))
const ID = '0b9d6d88-9a1d-4c4a-9a31-5a2f2d3a6f10'
const emailJob = {
  template: EmailTemplates.MAGIC_LINK,
  to: 'a@example.com',
  locale: Locales.ES,
  data: {},
  tags: { template: EmailTemplates.MAGIC_LINK }
}

function build() {
  const email = { send: jest.fn((_data: unknown) => Promise.resolve()) }
  const magicLinks = { issue: jest.fn(() => Promise.resolve()) }
  const invitations = { deliver: jest.fn(() => Promise.resolve('sent')) }
  const notices = {
    sent: jest.fn((_store: string, _request: string) => Promise.resolve()),
    failed: jest.fn((_store: string, _request: string, _code: string) => Promise.resolve())
  }
  const logger = { setContext: jest.fn(), error: jest.fn() }
  const processor = new EmailProcessor(
    {} as ProcessorSupport,
    email as unknown as EmailService,
    magicLinks as unknown as MagicLinkIssuer,
    invitations as unknown as InvitationEmailDelivery,
    notices as unknown as DsrNoticeLedger,
    cipher,
    logger as unknown as PinoLogger
  )
  const handle = (job: unknown) =>
    (processor as unknown as { handle(job: unknown): Promise<void> }).handle(job)
  return { email, magicLinks, invitations, notices, logger, handle }
}

describe('EmailProcessor', () => {
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

  it('sends any other job as an email', async () => {
    const { email, magicLinks, handle } = build()
    await handle({ name: JobNames.SEND_EMAIL, data: emailJob })

    expect(email.send).toHaveBeenCalledWith(emailJob)
    expect(magicLinks.issue).not.toHaveBeenCalled()
  })

  it('refuses a job it has no name for, instead of reading it as an email', async () => {
    const { email, magicLinks, handle } = build()

    await expect(handle({ name: 'something-else', data: {} })).rejects.toThrow(UnrecoverableError)

    expect(email.send).not.toHaveBeenCalled()
    expect(magicLinks.issue).not.toHaveBeenCalled()
  })
})

describe('EmailProcessor, invitation emails', () => {
  it('hands a request to deliver an invitation email to the delivery with its ids, and sends nothing itself', async () => {
    const { email, invitations, handle } = build()
    const job = {
      name: JobNames.DELIVER_INVITATION_EMAIL,
      data: { storeId: ID, invitationId: ID }
    } as unknown as Job

    await handle(job)

    expect(invitations.deliver).toHaveBeenCalledWith(ID, ID)
    expect(email.send).not.toHaveBeenCalled()
  })
})

describe('EmailProcessor, a payload that does not fit', () => {
  it.each([
    [JobNames.SEND_EMAIL, { template: 'magic-link', to: 'a@example.com' }],
    [JobNames.REQUEST_MAGIC_LINK, { email: 7 }],
    [JobNames.DELIVER_INVITATION_EMAIL, { storeId: 's1', invitationId: 'i1' }]
  ])('does not retry the %s job, and says nothing of its data', async (name, data) => {
    const { email, magicLinks, invitations, handle } = build()

    const error: unknown = await handle({ name, data }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(UnrecoverableError)
    expect((error as Error).message).not.toMatch(/a@example|s1|i1/)
    expect(email.send).not.toHaveBeenCalled()
    expect(magicLinks.issue).not.toHaveBeenCalled()
    expect(invitations.deliver).not.toHaveBeenCalled()
  })

  it('does not retry a template that rejects its data, and says nothing of the data', async () => {
    const { email, handle } = build()
    email.send.mockRejectedValueOnce(new ZodError([]))

    const error: unknown = await handle({ name: JobNames.SEND_EMAIL, data: emailJob }).catch(
      (caught: unknown) => caught
    )

    expect(error).toBeInstanceOf(UnrecoverableError)
  })
})

describe('EmailProcessor, the closing notice of a data request', () => {
  const dsrJob = (attemptsMade: number, attempts = 3) =>
    ({
      name: JobNames.SEND_EMAIL,
      attemptsMade,
      opts: { attempts },
      data: { ...emailJob, dsrNotice: { requestId: ID, storeId: ID } }
    }) as unknown as Job

  it('confirms the notice on the request once the mail left', async () => {
    const { notices, handle } = build()

    await handle(dsrJob(0))

    expect(notices.sent).toHaveBeenCalledWith(ID, ID)
    expect(notices.failed).not.toHaveBeenCalled()
  })

  it('does not touch a request for an ordinary email', async () => {
    const { notices, handle } = build()

    await handle({ name: JobNames.SEND_EMAIL, data: emailJob })

    expect(notices.sent).not.toHaveBeenCalled()
    expect(notices.failed).not.toHaveBeenCalled()
  })

  it('says nothing while the mail still has attempts left, and marks the request on the last one', async () => {
    const { email, notices, handle } = build()
    email.send.mockRejectedValue(new EmailDeliveryError('rate_limit', 429))

    await expect(handle(dsrJob(0))).rejects.toBeInstanceOf(EmailDeliveryError)
    await expect(handle(dsrJob(1))).rejects.toBeInstanceOf(EmailDeliveryError)
    expect(notices.failed).not.toHaveBeenCalled()

    await expect(handle(dsrJob(2))).rejects.toBeInstanceOf(EmailDeliveryError)
    expect(notices.failed).toHaveBeenCalledTimes(1)
    expect(notices.failed).toHaveBeenCalledWith(ID, ID, 'mail_failed')
    expect(notices.sent).not.toHaveBeenCalled()
  })

  it('marks the request at once for a mail that will never fit its template', async () => {
    const { email, notices, handle } = build()
    email.send.mockRejectedValueOnce(new ZodError([]))

    await expect(handle(dsrJob(0))).rejects.toBeInstanceOf(UnrecoverableError)

    expect(notices.failed).toHaveBeenCalledWith(ID, ID, 'mail_failed')
  })

  it('keeps the failure of the mail when the request cannot be marked, and does not log the address', async () => {
    const { email, notices, logger, handle } = build()
    email.send.mockRejectedValue(new EmailDeliveryError('rate_limit', 429))
    notices.failed.mockRejectedValue(new Error('db down for a@example.com'))

    await expect(handle(dsrJob(2))).rejects.toBeInstanceOf(EmailDeliveryError)

    expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(/a@example/)
  })

  it('does not send the mail again when the request cannot be told that it left', async () => {
    const { email, notices, handle } = build()
    notices.sent.mockRejectedValue(new Error('db down'))

    await expect(handle(dsrJob(0))).resolves.toBeUndefined()

    expect(email.send).toHaveBeenCalledTimes(1)
  })
})

describe('EmailProcessor, a failure that is not the provider', () => {
  const ADDRESS = 'victim.person@example.com'
  const database = Object.assign(new Error(`Unique constraint failed on (${ADDRESS})`), {
    name: 'PrismaClientKnownRequestError'
  })

  it.each([
    [
      'an invitation delivery',
      JobNames.DELIVER_INVITATION_EMAIL,
      { storeId: ID, invitationId: ID }
    ],
    ['a send of mail', JobNames.SEND_EMAIL, emailJob]
  ])('says only the name of what failed in %s', async (_label, name, data) => {
    const { email, invitations, handle } = build()
    invitations.deliver.mockRejectedValue(database)
    email.send.mockRejectedValue(database)

    const thrown: unknown = await handle({ name, data }).catch((caught: unknown) => caught)

    expect((thrown as Error).message).toBe('the mail job failed: PrismaClientKnownRequestError')
    expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown))).not.toContain(ADDRESS)
  })
})

describe('EmailProcessor, a sealed mail of a data request', () => {
  const dsrMail = {
    template: EmailTemplates.DSR_RESULT,
    to: 'ana@example.com',
    locale: Locales.ES,
    data: { downloadUrl: 'https://app.example.com/x#token=secret-token' },
    tags: { template: EmailTemplates.DSR_RESULT },
    dsrNotice: { requestId: ID, storeId: ID }
  }
  const sealedJob = (data: unknown) =>
    ({ name: JobNames.SEND_EMAIL, attemptsMade: 0, opts: { attempts: 3 }, data }) as unknown as Job

  it('opens the job, sends the mail as it was and confirms the notice', async () => {
    const { email, notices, handle } = build()

    await handle(sealedJob(sealMailJob(cipher, dsrMail)))

    expect(email.send).toHaveBeenCalledWith(dsrMail)
    expect(notices.sent).toHaveBeenCalledWith(ID, ID)
  })

  it('still serves a job queued in the clear before the deploy', async () => {
    const { email, handle } = build()

    await handle(sealedJob(dsrMail))

    expect(email.send).toHaveBeenCalledWith(dsrMail)
  })

  it.each([
    [
      'altered',
      (job: { sealed: string }) => ({
        ...job,
        sealed: Buffer.from(job.sealed, 'base64').fill(1, 20, 24).toString('base64')
      })
    ],
    [
      'moved to another request',
      (job: object) => ({ ...job, dsrNotice: { requestId: 'other', storeId: ID } })
    ],
    [
      'moved to another template',
      (job: object) => ({ ...job, template: EmailTemplates.MAGIC_LINK })
    ]
  ])(
    'refuses a job that was %s without sending or quoting it, and marks the request',
    async (_n, tamper) => {
      const { email, notices, handle } = build()
      const job = tamper(sealMailJob(cipher, dsrMail))

      const error: unknown = await handle(sealedJob(job)).catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(UnrecoverableError)
      expect(String((error as Error).message)).not.toMatch(/example\.com|secret-token/)
      expect(email.send).not.toHaveBeenCalled()
      expect(notices.sent).not.toHaveBeenCalled()
    }
  )

  it('fails closed with a job sealed under another key, naming nothing of it, and marks the request', async () => {
    const { email, notices, logger, handle } = build()
    const other = new CredentialCipher(parseEncryptionKey('d'.repeat(64)))

    const error: unknown = await handle(sealedJob(sealMailJob(other, dsrMail))).catch(
      (caught: unknown) => caught
    )

    expect(error).toBeInstanceOf(UnrecoverableError)
    expect(JSON.stringify([(error as Error).message, logger.error.mock.calls])).not.toMatch(
      /example\.com|secret-token/
    )
    expect(email.send).not.toHaveBeenCalled()
    expect(notices.failed).toHaveBeenCalledWith(ID, ID, 'mail_failed')
  })
})
