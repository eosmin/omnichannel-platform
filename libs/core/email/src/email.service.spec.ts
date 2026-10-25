import type { Counter } from '@prometheus-io/client'

import { Locales } from '@platform/core/i18n'
import { EmailTemplates, type SendEmailJob } from '@platform/core/queues'

import type { EmailProvider, SendEmailOptions } from './email-provider'
import { EmailService } from './email.service'
import { TemplateRenderer } from './template-renderer'

const job: SendEmailJob = {
  template: EmailTemplates.MAGIC_LINK,
  to: 'owner@example.com',
  locale: Locales.EN,
  data: { url: 'https://app.example.com/auth/magic?token=abc', expiresInMinutes: 15 },
  tags: { template: EmailTemplates.MAGIC_LINK }
}

function build(send: EmailProvider['send']): { service: EmailService; inc: jest.Mock } {
  const inc = jest.fn()
  const service = new EmailService(
    { send },
    'Platform <noreply@platform.local>',
    new TemplateRenderer(),
    { inc } as unknown as Counter<string> // A counter has only the one method used here
  )
  return { service, inc }
}

describe('EmailService', () => {
  it('renders the template and hands it to the provider with the sender and the tags', async () => {
    const send = jest.fn<Promise<{ providerMessageId: string }>, [SendEmailOptions]>(() =>
      Promise.resolve({ providerMessageId: 'id-1' })
    )
    const { service, inc } = build(send)

    await service.send(job)

    const options = send.mock.calls[0]?.[0]
    expect(options).toMatchObject({
      from: 'Platform <noreply@platform.local>',
      to: 'owner@example.com',
      subject: 'Your sign-in link',
      tags: { template: 'magic-link' }
    })
    expect(options?.html).toContain('https://app.example.com/auth/magic?token=abc')
    expect(inc).toHaveBeenCalledWith({ template: 'magic-link', status: 'sent' })
  })

  it('leaves out a tag without a value, such as the store of an account email', async () => {
    const send = jest.fn<Promise<{ providerMessageId: string }>, [SendEmailOptions]>(() =>
      Promise.resolve({ providerMessageId: 'id-1' })
    )
    await build(send).service.send({
      ...job,
      tags: { storeId: undefined, template: EmailTemplates.MAGIC_LINK }
    })
    expect(send.mock.calls[0]?.[0].tags).toEqual({ template: 'magic-link' })
  })

  it('decodes attachments', async () => {
    const send = jest.fn<Promise<{ providerMessageId: string }>, [SendEmailOptions]>(() =>
      Promise.resolve({ providerMessageId: 'id-1' })
    )
    await build(send).service.send({
      ...job,
      attachments: [
        {
          filename: 'a.txt',
          contentBase64: Buffer.from('hello').toString('base64'),
          contentType: 'text/plain'
        }
      ]
    })
    expect(send.mock.calls[0]?.[0].attachments?.[0]?.content.toString()).toBe('hello')
  })

  it('rethrows a provider failure so the queue retries, without counting it as an email sent', async () => {
    const { service, inc } = build(() => Promise.reject(new Error('provider down')))
    await expect(service.send(job)).rejects.toThrow('provider down')
    expect(inc).not.toHaveBeenCalled()
  })
})
