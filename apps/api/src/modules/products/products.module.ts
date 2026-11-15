import { Module } from '@nestjs/common'

import { TenancyModule } from '../tenancy'

import { PluginProductsController } from './plugin-products.controller'
import { ProductSearchService } from './product-search.service'
import { ProductVariantsService } from './product-variants.service'
import { ProductsController } from './products.controller'
import { ProductsService } from './products.service'

// Needs the database, audit and event modules of the app, like the customers
@Module({
  imports: [TenancyModule],
  controllers: [ProductsController, PluginProductsController],
  providers: [ProductsService, ProductVariantsService, ProductSearchService],
  exports: [ProductsService, ProductSearchService]
})
export class ProductsModule {}
