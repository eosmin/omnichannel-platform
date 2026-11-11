import { Module } from '@nestjs/common'

import { CryptoPlatformModule, QueuesPlatformModule } from '@platform/core/http'
import {
  MergedLabels,
  ShipmentLabels,
  ShipmentWrites,
  ShippingService
} from '@platform/core/shipping'

import { ChannelRegistryModule } from '../channel-registry'
import { TenancyModule } from '../tenancy'

import { BulkLabelsService } from './bulk-labels.service'
import { ShipmentsController } from './shipments.controller'
import { ShipmentsService } from './shipments.service'

// The shipment engine and its routes (TDD_17 §6). The carriers come from the registry module, the cipher of the credentials
// from the crypto module and the queue of the scan of a label from the queues one; the database, the audit and the event
// modules are the app's.
@Module({
  imports: [ChannelRegistryModule, CryptoPlatformModule, QueuesPlatformModule, TenancyModule],
  controllers: [ShipmentsController],
  providers: [
    ShippingService,
    ShipmentWrites,
    ShipmentLabels,
    MergedLabels,
    ShipmentsService,
    BulkLabelsService
  ],
  exports: [ShipmentsService, ShippingService]
})
export class ShipmentsModule {}
