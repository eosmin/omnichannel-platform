import { Module } from '@nestjs/common'

import { InventoryModule } from '@platform/core/inventory'

import { ExportsModule } from '../exports'
import { TenancyModule } from '../tenancy'

import { OrderShipmentEffects } from './order-shipment-effects.service'
import { OrderInventoryService } from './orders-inventory.service'
import { OrdersStatusService } from './orders-status.service'
import { OrdersController } from './orders.controller'
import { OrdersService } from './orders.service'
import { ShipmentEffectsListener } from './shipment-effects.listener'

// Needs the database, audit and event modules of the app, like the products. The stock goes only through
// InventoryService (TDD_16 §4.1)
@Module({
  imports: [TenancyModule, InventoryModule, ExportsModule],
  controllers: [OrdersController],
  providers: [
    OrdersService,
    OrdersStatusService,
    OrderInventoryService,
    OrderShipmentEffects,
    ShipmentEffectsListener
  ],
  exports: [OrdersService]
})
export class OrdersModule {}
