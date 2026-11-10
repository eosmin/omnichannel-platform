import { Module } from '@nestjs/common'

import { TenancyModule } from '../tenancy'

import { WarehouseLinksService } from './warehouse-links.service'
import { WarehousesController } from './warehouses.controller'
import { WarehousesService } from './warehouses.service'

// Needs the database and audit modules of the app, like the products
@Module({
  imports: [TenancyModule],
  controllers: [WarehousesController],
  providers: [WarehousesService, WarehouseLinksService]
})
export class WarehousesModule {}
