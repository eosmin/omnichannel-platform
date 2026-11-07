import { type Job, UnrecoverableError } from 'bullmq'

import type { EmailService } from '@platform/core/email'
import type { MagicLinkIssuer } from '@platform/core/magic-link-issuer'
import { JobNames, type RequestMagicLinkJob } from '@platform/core/queues'

import { EmailProcessor } from './email.processor'
import type { ProcessorSupport } from './processor-support'

function build() {
  const email = { send: jest.fn(() => Promise.resolve()) }
  const magicLinks = { issue: jest.fn(() => Promise.resolve()) }
  const processor = new EmailProcessor(
    {} as ProcessorSupport,
    email as unknown as EmailService,
    magicLinks as unknown as MagicLinkIssuer
  )
  const handle = (job: unknown) =>
    (processor as unknown as { handle(job: unknown): Promise<void> }).handle(job)
  return { email, magicLinks, handle }
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
    const data = { template: 'magic-link', to: 'a@example.com' }

    await handle({ name: JobNames.SEND_EMAIL, data })

    expect(email.send).toHaveBeenCalledWith(data)
    expect(magicLinks.issue).not.toHaveBeenCalled()
  })

  it('refuses a job it has no name for, instead of reading it as an email', async () => {
    const { email, magicLinks, handle } = build()

    await expect(handle({ name: 'something-else', data: {} })).rejects.toThrow(UnrecoverableError)

    expect(email.send).not.toHaveBeenCalled()
    expect(magicLinks.issue).not.toHaveBeenCalled()
  })
})
