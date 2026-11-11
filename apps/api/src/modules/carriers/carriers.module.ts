import { Module } from '@nestjs/common'

import {
  CryptoPlatformModule,
  PublicApiPlatformModule,
  QueuesPlatformModule
} from '@platform/core/http'

import { ChannelRegistryModule } from '../channel-registry'
import { TenancyModule } from '../tenancy'

import { CarrierConnectionsController } from './carrier-connections.controller'
import { CarrierConnectionsService } from './carrier-connections.service'
import { CarrierStatusMappingsController } from './carrier-status-mappings.controller'
import { CarrierStatusMappingsService } from './carrier-status-mappings.service'
import { CarrierWebhookController } from './carrier-webhook.controller'
import { CarrierWebhookService } from './carrier-webhook.service'

// Settings → Carriers: the connections of the store with their carriers, what their statuses mean, and the public door the
// carriers push to (TDD_17 §4.9, §4.17, §6). The registries come from the registry module, the cipher of the credentials
// from the crypto module, the address the carrier calls from the public API one and the webhooks queue from the queues one.
@Module({
  imports: [
    ChannelRegistryModule,
    CryptoPlatformModule,
    PublicApiPlatformModule,
    QueuesPlatformModule,
    TenancyModule
  ],
  controllers: [
    CarrierConnectionsController,
    CarrierStatusMappingsController,
    CarrierWebhookController
  ],
  providers: [CarrierConnectionsService, CarrierStatusMappingsService, CarrierWebhookService],
  exports: [CarrierConnectionsService]
})
export class CarriersModule {}
