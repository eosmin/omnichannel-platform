import { Resend } from 'resend'

import type { EmailProvider, SendEmailOptions } from '../email-provider'

export class ResendProvider implements EmailProvider {
  private readonly resend: Resend

  constructor(apiKey: string) {
    this.resend = new Resend(apiKey)
  }

  async send(options: SendEmailOptions): Promise<{ providerMessageId: string }> {
    const { data, error } = await this.resend.emails.send({
      from: options.from,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
      replyTo: options.replyTo,
      headers: options.headers,
      tags: Object.entries(options.tags).map(([name, value]) => ({ name, value })),
      attachments: options.attachments?.map(attachment => ({
        filename: attachment.filename,
        content: attachment.content,
        contentType: attachment.contentType
      }))
    })
    // The SDK returns failures as values. Throwing lets the queue retry (a 5xx or a rate limit) and,
    // once the attempts are spent, send the job to the dead-letter queue.
    if (error !== null) {
      throw new Error(
        `resend rejected the email: ${error.name} (${error.statusCode ?? 'network'}) ${error.message}`
      )
    }
    return { providerMessageId: data.id }
  }
}
