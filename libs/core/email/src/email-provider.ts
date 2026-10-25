export interface SendEmailOptions {
  from: string
  to: string | string[]
  subject: string
  html: string
  text: string
  replyTo?: string
  headers?: Record<string, string>
  tags: Record<string, string>
  attachments?: { filename: string; content: Buffer; contentType: string }[]
}

// Callers depend on this, never on a provider: a second provider is one more class and one more
// branch in selectEmailProvider.
export interface EmailProvider {
  send(options: SendEmailOptions): Promise<{ providerMessageId: string }>
}

export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER')

// The sender every email goes out from (EMAIL_FROM)
export const EMAIL_FROM = Symbol('EMAIL_FROM')
