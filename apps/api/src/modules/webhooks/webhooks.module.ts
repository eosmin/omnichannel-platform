import { Module } from '@nestjs/common'

import { EmailPlatformModule, QueuesPlatformModule } from '@platform/core/http'

import { ResendWebhookController } from './resend-webhook.controller'

// A module sees only what it imports: the verifier comes from the email module and the analytics
// queue from the queues module (the idempotency service is global, from the database module)
@Module({
  imports: [EmailPlatformModule, QueuesPlatformModule],
  controllers: [ResendWebhookController]
})
export class WebhooksModule {}
