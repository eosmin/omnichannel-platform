import { createTransport, type Transporter } from 'nodemailer'

import type { EmailProvider, SendEmailOptions } from '../email-provider'

// Development and CI only: SMTP into Mailpit (http://localhost:8025). It is the one place where a
// second provider class exists (TDD_14 §10).
export class MailpitProvider implements EmailProvider {
  private readonly transport: Transporter

  constructor(smtpUrl: string) {
    this.transport = createTransport(smtpUrl)
  }

  async send(options: SendEmailOptions): Promise<{ providerMessageId: string }> {
    const info = await this.transport.sendMail({
      from: options.from,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
      replyTo: options.replyTo,
      headers: { ...options.headers, 'X-Tags': JSON.stringify(options.tags) },
      attachments: options.attachments?.map(attachment => ({
        filename: attachment.filename,
        content: attachment.content,
        contentType: attachment.contentType
      }))
    })
    return { providerMessageId: info.messageId }
  }
}
