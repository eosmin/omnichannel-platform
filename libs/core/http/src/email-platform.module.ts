import { Module } from '@nestjs/common'

import { env } from '@platform/core/config/env'
import { EmailModule, senderOf } from '@platform/core/email'

// Sending email, configured from the validated env: Resend when RESEND_API_KEY is set, Mailpit
// through SMTP_URL otherwise.
@Module({
  imports: [
    EmailModule.forRoot({
      from: senderOf(env.EMAIL_FROM, env.EMAIL_FROM_NAME),
      resendApiKey: env.RESEND_API_KEY,
      resendWebhookSecret: env.RESEND_WEBHOOK_SECRET,
      smtpUrl: env.SMTP_URL
    })
  ],
  exports: [EmailModule]
})
export class EmailPlatformModule {}
