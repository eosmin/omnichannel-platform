import { EmailDeliveryError, EmailDeliveryFallback } from '../email-delivery-error'

import { ResendProvider } from './resend.provider'

const mockSend = jest.fn()

jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: mockSend } }))
}))

const OPTIONS = {
  from: 'Platform <noreply@platform.local>',
  to: 'victim.person@example.com',
  subject: 's',
  html: '<p>h</p>',
  text: 't',
  tags: { template: 'magic-link' }
}

describe('ResendProvider', () => {
  beforeEach(() => mockSend.mockReset())

  it('returns the id of the message the provider took', async () => {
    mockSend.mockResolvedValue({ data: { id: 'msg-1' }, error: null })

    await expect(new ResendProvider('key').send(OPTIONS)).resolves.toEqual({
      providerMessageId: 'msg-1'
    })
  })

  it('throws what the provider refused by its name and status, never by its text, which can hold the address', async () => {
    mockSend.mockResolvedValue({
      data: null,
      error: {
        name: 'validation_error',
        statusCode: 422,
        message: `Invalid \`to\` field: ${OPTIONS.to}`
      }
    })

    const thrown: unknown = await new ResendProvider('key').send(OPTIONS).then(
      () => null,
      (failure: unknown) => failure
    )

    expect(thrown).toBeInstanceOf(EmailDeliveryError)
    const error = thrown as EmailDeliveryError
    expect(error.kind).toBe('validation_error')
    expect(error.providerCode).toBe('422')
    expect(error.message).not.toContain(OPTIONS.to)
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(OPTIONS.to)
  })

  it('says network when the provider gave no status', async () => {
    mockSend.mockResolvedValue({
      data: null,
      error: { name: 'application_error', statusCode: null, message: 'x' }
    })

    const thrown = await new ResendProvider('key').send(OPTIONS).catch((e: unknown) => e)

    expect((thrown as EmailDeliveryError).providerCode).toBe(EmailDeliveryFallback.NO_STATUS)
  })
})
