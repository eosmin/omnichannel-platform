import { Module } from '@nestjs/common'

import { CryptoPlatformModule } from '@platform/core/http'
import { ShipmentReplayer, ShipmentStatusEngine, ShipmentWrites } from '@platform/core/shipping'
import { PluginsModule } from '@platform/plugins/runtime'

import { CarrierEventApplier } from './carrier-event-applier.service'
import { CarrierEventReplay } from './carrier-event-replay.service'
import { CarrierEventResolver } from './carrier-event-resolver.service'

// What the worker does with what a carrier says (TDD_17 §4.9, §4.17): the webhook jobs, the poll and the replay of the lines kept
// under a code the owner has mapped all go through the same applier and the same status engine. The database, the bus, the
// metrics and the logger are the global modules of the worker; the carriers come from the plugins module.
@Module({
  imports: [CryptoPlatformModule, PluginsModule.forRoot()],
  providers: [
    CarrierEventResolver,
    CarrierEventApplier,
    CarrierEventReplay,
    ShipmentStatusEngine,
    ShipmentWrites,
    ShipmentReplayer
  ],
  exports: [CarrierEventApplier, CarrierEventReplay]
})
export class CarriersWorkerModule {}
