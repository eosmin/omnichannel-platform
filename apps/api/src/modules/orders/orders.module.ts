import { Module } from '@nestjs/common'

import { InventoryModule } from '@platform/core/inventory'

import { ChannelRegistryModule } from '../channel-registry'
import { ExportsModule } from '../exports'
import { ShipmentsModule } from '../shipments/shipments.module'
import { TenancyModule } from '../tenancy'

import { OrderGuides } from './order-guides.service'
import { OrderReturnEffects } from './order-return-effects.service'
import { OrderShipmentEffects } from './order-shipment-effects.service'
import { OrderInventoryService } from './orders-inventory.service'
import { OrdersStatusService } from './orders-status.service'
import { OrdersController } from './orders.controller'
import { OrdersService } from './orders.service'
import { ShipmentEffectsListener } from './shipment-effects.listener'

// Needs the database, audit and event modules of the app, like the products. The stock goes only through
// InventoryService (TDD_16 §4.1)
@Module({
  imports: [TenancyModule, InventoryModule, ExportsModule, ChannelRegistryModule, ShipmentsModule],
  controllers: [OrdersController],
  providers: [
    OrdersService,
    OrdersStatusService,
    OrderInventoryService,
    OrderShipmentEffects,
    OrderGuides,
    OrderReturnEffects,
    ShipmentEffectsListener
  ],
  exports: [OrdersService, OrdersStatusService, OrderReturnEffects]
})
export class OrdersModule {}
