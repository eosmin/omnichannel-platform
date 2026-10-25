import { Module } from '@nestjs/common'

import { env } from '@platform/core/config/env'
import { EmailModule } from '@platform/core/email'

// Sending email, configured from the validated env: Resend when RESEND_API_KEY is set, Mailpit
// through SMTP_URL otherwise.
@Module({
  imports: [
    EmailModule.forRoot({
      from: env.EMAIL_FROM,
      resendApiKey: env.RESEND_API_KEY,
      resendWebhookSecret: env.RESEND_WEBHOOK_SECRET,
      smtpUrl: env.SMTP_URL
    })
  ],
  exports: [EmailModule]
})
export class EmailPlatformModule {}
