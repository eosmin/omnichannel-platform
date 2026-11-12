import { Module } from '@nestjs/common'

import { InventoryModule } from '@platform/core/inventory'
import { ReturnOrderPort, ReturnsService } from '@platform/core/shipping'

import { OrderReturnEffects } from '../orders/order-return-effects.service'
import { OrdersModule } from '../orders/orders.module'
import { ShipmentsModule } from '../shipments/shipments.module'
import { TenancyModule } from '../tenancy'

import { ReturnsController } from './returns.controller'
import { ReturnsQueries } from './returns.queries'

// The returns of the store and their routes (TDD_17 §4.11). The stock goes only through InventoryService, the order only
// through the orders module and a shipment status only through the shipment engine; the database, audit and event modules are
// the app's.
@Module({
  imports: [TenancyModule, InventoryModule, OrdersModule, ShipmentsModule],
  controllers: [ReturnsController],
  providers: [
    ReturnsService,
    ReturnsQueries,
    { provide: ReturnOrderPort, useExisting: OrderReturnEffects }
  ],
  exports: [ReturnsService]
})
export class ReturnsModule {}
