import { type DynamicModule, Module } from '@nestjs/common'

import { EMAIL_FROM, EMAIL_PROVIDER } from './email-provider'
import { EmailService } from './email.service'
import { type EmailTransportOptions, selectEmailProvider } from './providers/select-email-provider'
import { ResendWebhookVerifier } from './resend-webhook-verifier'
import { TemplateRenderer } from './template-renderer'

export interface EmailModuleOptions extends EmailTransportOptions {
  from: string
  resendWebhookSecret?: string | undefined
}

@Module({})
export class EmailModule {
  static forRoot(options: EmailModuleOptions): DynamicModule {
    return {
      module: EmailModule,
      providers: [
        { provide: EMAIL_PROVIDER, useFactory: () => selectEmailProvider(options) },
        { provide: EMAIL_FROM, useValue: options.from },
        {
          provide: ResendWebhookVerifier,
          useFactory: () => new ResendWebhookVerifier(options.resendWebhookSecret)
        },
        TemplateRenderer,
        EmailService
      ],
      exports: [EmailService, ResendWebhookVerifier]
    }
  }
}
