import { Module } from '@nestjs/common'

import { InventoryModule } from '@platform/core/inventory'

import { ExportsModule } from '../exports'
import { TenancyModule } from '../tenancy'

import { OrderInventoryService } from './orders-inventory.service'
import { OrdersStatusService } from './orders-status.service'
import { OrdersController } from './orders.controller'
import { OrdersService } from './orders.service'

// Needs the database, audit and event modules of the app, like the products. The stock goes only through
// InventoryService (TDD_16 §4.1)
@Module({
  imports: [TenancyModule, InventoryModule, ExportsModule],
  controllers: [OrdersController],
  providers: [OrdersService, OrdersStatusService, OrderInventoryService],
  exports: [OrdersService]
})
export class OrdersModule {}
