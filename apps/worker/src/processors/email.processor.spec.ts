import { type Job, UnrecoverableError } from 'bullmq'
import { ZodError } from 'zod'

import type { EmailService } from '@platform/core/email'
import { Locales } from '@platform/core/i18n'
import type { MagicLinkIssuer } from '@platform/core/magic-link-issuer'
import { EmailTemplates, JobNames, type RequestMagicLinkJob } from '@platform/core/queues'

import type { InvitationEmailDelivery } from '../invitations/invitation-email-delivery.service'

import { EmailProcessor } from './email.processor'
import type { ProcessorSupport } from './processor-support'

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
  const processor = new EmailProcessor(
    {} as ProcessorSupport,
    email as unknown as EmailService,
    magicLinks as unknown as MagicLinkIssuer,
    invitations as unknown as InvitationEmailDelivery
  )
  const handle = (job: unknown) =>
    (processor as unknown as { handle(job: unknown): Promise<void> }).handle(job)
  return { email, magicLinks, invitations, handle }
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
