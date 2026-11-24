import type { Counter } from '@prometheus-io/client'

import { Locales } from '@platform/core/i18n'
import { EmailTemplates, type SendEmailJob } from '@platform/core/queues'

import { EmailDeliveryError, EmailDeliveryFallback } from './email-delivery-error'
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

  it('hands the extra headers of the job to the provider', async () => {
    const send = jest.fn<Promise<{ providerMessageId: string }>, [SendEmailOptions]>(() =>
      Promise.resolve({ providerMessageId: 'id-1' })
    )
    await build(send).service.send({
      ...job,
      headers: { 'List-Unsubscribe': '<https://app.example.com/account/notifications>' }
    })
    expect(send.mock.calls[0]?.[0].headers).toEqual({
      'List-Unsubscribe': '<https://app.example.com/account/notifications>'
    })
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

  it('throws a provider failure so the queue retries, without counting it as an email sent', async () => {
    const { service, inc } = build(() => Promise.reject(new Error('provider down')))
    await expect(service.send(job)).rejects.toBeInstanceOf(EmailDeliveryError)
    expect(inc).not.toHaveBeenCalled()
  })

  // What a provider says about a refusal can hold the address it was given: the error that leaves the service holds the name and the code only
  describe('an error of the provider that carries the address', () => {
    const ADDRESS = 'victim.person@example.com'
    const smtp = Object.assign(new Error(`550 5.1.1 <${ADDRESS}>: Recipient address rejected`), {
      code: 'EENVELOPE',
      response: `550 5.1.1 <${ADDRESS}>: Recipient address rejected`,
      rejected: [ADDRESS],
      envelope: { from: 'noreply@platform.local', to: [ADDRESS] }
    })

    async function thrownBy(error: Error): Promise<EmailDeliveryError> {
      const { service } = build(() => Promise.reject(error))
      const thrown: unknown = await service.send(job).then(
        () => null,
        (failure: unknown) => failure
      )
      if (!(thrown instanceof EmailDeliveryError)) throw new Error('not an EmailDeliveryError')
      return thrown
    }

    it('keeps the address out of the message, the stack, the properties and the cause', async () => {
      const thrown = await thrownBy(smtp)

      expect(thrown.message).not.toContain(ADDRESS)
      expect(thrown.stack ?? '').not.toContain(ADDRESS)
      expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown))).not.toContain(ADDRESS)
      expect(thrown.cause).toBeUndefined()
    })

    it('says what failed by the name and the code of the error, which are safe', async () => {
      const thrown = await thrownBy(smtp)

      expect(thrown.kind).toBe('Error')
      expect(thrown.providerCode).toBe('EENVELOPE')
      expect(thrown.message).toContain('EENVELOPE')
    })

    it('does not trust a name or a code that is not a plain token', async () => {
      const odd = Object.assign(new Error('x'), {
        name: `Bad ${ADDRESS}`,
        code: `550 ${ADDRESS}`
      })

      const thrown = await thrownBy(odd)

      expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown))).not.toContain(ADDRESS)
      expect(thrown.kind).toBe(EmailDeliveryFallback.KIND)
      expect(thrown.providerCode).toBeNull()
    })

    it('lets an error the provider already made safe pass as it is', async () => {
      const safe = new EmailDeliveryError('validation_error', 422)
      const { service } = build(() => Promise.reject(safe))

      await expect(service.send(job)).rejects.toBe(safe)
    })
  })

  it('does not turn a template that the data does not fit into a delivery error', async () => {
    const { service } = build(() => Promise.resolve({ providerMessageId: 'id-1' }))

    const thrown: unknown = await service
      .send({ ...job, data: { url: 'javascript:alert(1)', expiresInMinutes: 15 } })
      .then(
        () => null,
        (failure: unknown) => failure
      )

    expect(thrown).toBeInstanceOf(Error)
    expect(thrown).not.toBeInstanceOf(EmailDeliveryError)
  })
})
