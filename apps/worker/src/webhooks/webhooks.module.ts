import { Module } from '@nestjs/common'

import { CryptoPlatformModule } from '@platform/core/http'

import { PluginWebhookDeliverer } from './plugin-webhook-deliverer.service'
import { TenantWebhookDeliverer } from './tenant-webhook-deliverer.service'

// The outbound webhooks of the stores (TDD_07 §2) and of the plugins (TDD_10 §6.5): the processor of the webhooks queue hands them to
// their deliverer. The database,
// the bus, the metrics and the logger are the global modules of the worker.
@Module({
  imports: [CryptoPlatformModule],
  providers: [PluginWebhookDeliverer, TenantWebhookDeliverer],
  exports: [PluginWebhookDeliverer, TenantWebhookDeliverer]
})
export class WebhooksWorkerModule {}
