import { Module } from '@nestjs/common'

import { InventoryModule as InventoryEngineModule } from '@platform/core/inventory'

import { TenancyModule } from '../tenancy'

import { InventoryAdjustmentsService } from './inventory-adjustments.service'
import { InventoryQueriesService } from './inventory-queries.service'
import { InventoryController } from './inventory.controller'

// The routes of stock of a store: levels, movements, the kardex and the adjustments. The engine that writes them is
// InventoryService of libs/core/inventory.
@Module({
  imports: [InventoryEngineModule, TenancyModule],
  controllers: [InventoryController],
  providers: [InventoryQueriesService, InventoryAdjustmentsService],
  exports: [InventoryEngineModule]
})
export class InventoryModule {}
