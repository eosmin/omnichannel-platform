import { Module } from '@nestjs/common'

import { CryptoPlatformModule, QueuesPlatformModule } from '@platform/core/http'
import { PickupSync, PickupsService, ShipmentWrites } from '@platform/core/shipping'

import { ChannelRegistryModule } from '../channel-registry'
import { TenancyModule } from '../tenancy'

import { PickupQueue } from './pickup-queue.service'
import { PickupsController } from './pickups.controller'
import { PickupsApiService } from './pickups.service'

// The pickups of the store and their routes (TDD_17 §4.10, §6). The carriers come from the registry module, the cipher of the
// credentials from the crypto module and the queue of the sync from the queues one; the database, the audit and the event modules
// are the app's.
@Module({
  imports: [ChannelRegistryModule, CryptoPlatformModule, QueuesPlatformModule, TenancyModule],
  controllers: [PickupsController],
  // `PickupSync` is the worker's job; it is a provider here too so that the integration suite runs it against the same wiring
  providers: [PickupsService, PickupSync, ShipmentWrites, PickupQueue, PickupsApiService]
})
export class PickupsModule {}
