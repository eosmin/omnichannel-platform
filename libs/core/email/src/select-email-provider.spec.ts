import { MailpitProvider } from './providers/mailpit.provider'
import { ResendProvider } from './providers/resend.provider'
import { selectEmailProvider } from './providers/select-email-provider'

describe('selectEmailProvider', () => {
  it('uses Resend when the key is set, even if SMTP is set too', () => {
    expect(
      selectEmailProvider({ resendApiKey: 're_key', smtpUrl: 'smtp://localhost:1025' })
    ).toBeInstanceOf(ResendProvider)
  })

  it('uses Mailpit through SMTP when there is no key', () => {
    expect(selectEmailProvider({ smtpUrl: 'smtp://localhost:1025' })).toBeInstanceOf(
      MailpitProvider
    )
  })

  it('refuses to start without a transport', () => {
    expect(() => selectEmailProvider({})).toThrow(/RESEND_API_KEY/)
  })
})
