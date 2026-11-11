import { Module } from '@nestjs/common'

import { InventoryModule as InventoryEngineModule } from '@platform/core/inventory'

import { TenancyModule } from '../tenancy'

import { TransfersController } from './transfers.controller'
import { TransfersService } from './transfers.service'

// The transfers between warehouses of an organization. The stock they move is written by InventoryService of
// libs/core/inventory; the database, audit and event-bus modules are global in the app, like in the warehouses.
@Module({
  imports: [InventoryEngineModule, TenancyModule],
  controllers: [TransfersController],
  providers: [TransfersService]
})
export class TransfersModule {}
