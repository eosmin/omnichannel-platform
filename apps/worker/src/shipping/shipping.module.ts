import { Module } from '@nestjs/common'

import { CryptoPlatformModule } from '@platform/core/http'
import { ShipmentStatusEngine, ShipmentWrites } from '@platform/core/shipping'
import { PluginsModule } from '@platform/plugins/runtime'

import { ShipmentPoller } from './shipment-poller.service'

// The worker half of the shipments (TDD_17 §4.9): the poll of the carriers. The engine writes through `ShipmentWrites`, which
// announces each move on the event bus; the database, the bus and the logger are the global modules of the worker, and the
// carriers come from the plugins module.
@Module({
  imports: [CryptoPlatformModule, PluginsModule.forRoot()],
  providers: [ShipmentPoller, ShipmentStatusEngine, ShipmentWrites],
  exports: [ShipmentPoller]
})
export class ShippingWorkerModule {}
