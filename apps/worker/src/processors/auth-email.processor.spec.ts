import { type Job, UnrecoverableError } from 'bullmq'
import { ZodError } from 'zod'

import type { EmailService } from '@platform/core/email'
import type { MagicLinkIssuer } from '@platform/core/magic-link-issuer'
import { JobNames, type RequestMagicLinkJob } from '@platform/core/queues'

import { AuthEmailProcessor } from './auth-email.processor'
import type { ProcessorSupport } from './processor-support'

function build() {
  const email = { send: jest.fn((_data: unknown) => Promise.resolve()) }
  const magicLinks = {
    issue: jest.fn((_email: string, _correlationId?: string) => Promise.resolve())
  }
  const processor = new AuthEmailProcessor(
    {} as ProcessorSupport,
    email as unknown as EmailService,
    magicLinks as unknown as MagicLinkIssuer
  )
  const handle = (job: unknown) =>
    (processor as unknown as { handle(job: unknown): Promise<void> }).handle(job)
  return { email, magicLinks, handle }
}

describe('AuthEmailProcessor', () => {
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
    const data = { template: 'magic-link', to: 'a@example.com' }

    await handle({ name: JobNames.SEND_EMAIL, data })

    expect(email.send).toHaveBeenCalledWith(data)
    expect(magicLinks.issue).not.toHaveBeenCalled()
  })

  it('does not retry a payload the template rejects', async () => {
    const { email, handle } = build()
    email.send.mockRejectedValueOnce(new ZodError([]))

    await expect(handle({ name: JobNames.SEND_EMAIL, data: {} })).rejects.toThrow(
      UnrecoverableError
    )
  })

  it('refuses a job it has no name for, and never reads an invitation delivery as an email', async () => {
    const { email, magicLinks, handle } = build()

    await expect(
      handle({ name: JobNames.DELIVER_INVITATION_EMAIL, data: { storeId: 's', invitationId: 'i' } })
    ).rejects.toThrow(UnrecoverableError)

    expect(email.send).not.toHaveBeenCalled()
    expect(magicLinks.issue).not.toHaveBeenCalled()
  })
})
