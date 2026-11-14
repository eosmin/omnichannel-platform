import { Module } from '@nestjs/common'

import { TenancyModule } from '../tenancy'

import { ProductSearchService } from './product-search.service'
import { ProductVariantsService } from './product-variants.service'
import { ProductsController } from './products.controller'
import { ProductsService } from './products.service'

// Needs the database, audit and event modules of the app, like the customers
@Module({
  imports: [TenancyModule],
  controllers: [ProductsController],
  providers: [ProductsService, ProductVariantsService, ProductSearchService],
  exports: [ProductsService, ProductSearchService]
})
export class ProductsModule {}
