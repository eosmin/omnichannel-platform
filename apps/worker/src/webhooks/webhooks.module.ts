import { Module } from '@nestjs/common'

import { CryptoPlatformModule } from '@platform/core/http'

import { TenantWebhookDeliverer } from './tenant-webhook-deliverer.service'

// The outbound webhooks of the stores (TDD_07 §2): the processor of the webhooks queue hands them to the deliverer. The database,
// the bus, the metrics and the logger are the global modules of the worker.
@Module({
  imports: [CryptoPlatformModule],
  providers: [TenantWebhookDeliverer],
  exports: [TenantWebhookDeliverer]
})
export class WebhooksWorkerModule {}
