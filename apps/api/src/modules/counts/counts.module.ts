import { Module } from '@nestjs/common'

import { InventoryModule as InventoryEngineModule } from '@platform/core/inventory'

import { TenancyModule } from '../tenancy'

import { CountsApplyService } from './counts-apply.service'
import { CountsController } from './counts.controller'
import { CountsService } from './counts.service'

// The physical counts of a warehouse. The stock they write goes through InventoryService of libs/core/inventory.
@Module({
  imports: [InventoryEngineModule, TenancyModule],
  controllers: [CountsController],
  providers: [CountsService, CountsApplyService]
})
export class CountsModule {}
