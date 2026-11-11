import { Module } from '@nestjs/common'

import { CryptoPlatformModule, PublicApiPlatformModule } from '@platform/core/http'

import { ChannelRegistryModule } from '../channel-registry'
import { TenancyModule } from '../tenancy'

import { CarrierConnectionsController } from './carrier-connections.controller'
import { CarrierConnectionsService } from './carrier-connections.service'

// Settings → Carriers: the connections of the store with their carriers (TDD_17 §6). The registries come from the registry
// module, the cipher of the credentials from the crypto module, and the address the carrier calls from the public API one.
@Module({
  imports: [ChannelRegistryModule, CryptoPlatformModule, PublicApiPlatformModule, TenancyModule],
  controllers: [CarrierConnectionsController],
  providers: [CarrierConnectionsService],
  exports: [CarrierConnectionsService]
})
export class CarriersModule {}
