import { Module } from '@nestjs/common'

import { CryptoPlatformModule, QueuesPlatformModule } from '@platform/core/http'
import {
  MergedLabels,
  ShipmentCancellation,
  ShipmentLabels,
  ShipmentWrites,
  ShippingService
} from '@platform/core/shipping'
import { PluginsModule } from '@platform/plugins/runtime'

import { CarriersWorkerModule } from '../carriers/carriers.module'

import { BulkLabelsCleaner } from './bulk-labels-cleaner.service'
import { BulkLabelsRunner } from './bulk-labels-runner.service'
import { ShipmentCanceller } from './shipment-canceller.service'
import { ShipmentPoller } from './shipment-poller.service'

// The worker half of the shipments (TDD_17 §4.6, §4.9): the poll of the carriers, the bulk generation of labels and the void of a guide. The engine
// writes through `ShipmentWrites`, which announces each move on the event bus; the database, the bus, the storage and the logger
// are the global modules of the worker, the carriers come from the plugins module and the queue where a label from a carrier is
// scanned from the queues one.
@Module({
  imports: [
    CryptoPlatformModule,
    QueuesPlatformModule,
    PluginsModule.forRoot(),
    CarriersWorkerModule
  ],
  providers: [
    ShipmentPoller,
    ShippingService,
    ShipmentWrites,
    ShipmentLabels,
    MergedLabels,
    BulkLabelsRunner,
    BulkLabelsCleaner,
    ShipmentCancellation,
    ShipmentCanceller
  ],
  exports: [ShipmentPoller, BulkLabelsRunner, BulkLabelsCleaner, ShipmentCanceller]
})
export class ShippingWorkerModule {}
