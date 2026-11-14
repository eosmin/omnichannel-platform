import { Module } from '@nestjs/common'

import { CryptoPlatformModule, QueuesPlatformModule } from '@platform/core/http'

import { TenancyModule } from '../tenancy'

import { TenantWebhooksController } from './tenant-webhooks.controller'
import { TenantWebhooksService } from './tenant-webhooks.service'
import { WebhookDispatcher } from './webhook-dispatcher'

// Settings → Webhooks and the dispatcher that queues their deliveries. Needs the database, audit and event modules of the app;
// the cipher of the secrets comes from the crypto module and the webhooks queue from the queues one.
@Module({
  imports: [CryptoPlatformModule, QueuesPlatformModule, TenancyModule],
  controllers: [TenantWebhooksController],
  providers: [TenantWebhooksService, WebhookDispatcher]
})
export class TenantWebhooksModule {}
