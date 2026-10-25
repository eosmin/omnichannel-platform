import type { EmailProvider } from '../email-provider'

import { MailpitProvider } from './mailpit.provider'
import { ResendProvider } from './resend.provider'

export interface EmailTransportOptions {
  resendApiKey?: string
  smtpUrl?: string
}

// The key wins, so that moving from Mailpit to Resend is only setting RESEND_API_KEY. The env schema
// guarantees one of them, and that a deployed environment has the key.
export function selectEmailProvider(options: EmailTransportOptions): EmailProvider {
  if (options.resendApiKey !== undefined) return new ResendProvider(options.resendApiKey)
  if (options.smtpUrl !== undefined) return new MailpitProvider(options.smtpUrl)
  throw new Error('no email transport: set RESEND_API_KEY, or SMTP_URL to send through Mailpit')
}
