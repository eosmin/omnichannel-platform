import { Module } from '@nestjs/common'

import { QueuesPlatformModule, SearchPlatformModule } from '@platform/core/http'

import { ProductsModule } from '../products/products.module'
import { TenancyModule } from '../tenancy'

import { SearchRunner } from './search-runner.service'
import { SearchTracker } from './search-tracker.service'
import { SearchController } from './search.controller'
import { SearchService } from './search.service'

// The search needs the database module of the app (global), the queues module for the analytics queue, and the product
// autocomplete of the catalog, which the products module exports
@Module({
  imports: [TenancyModule, QueuesPlatformModule, SearchPlatformModule, ProductsModule],
  controllers: [SearchController],
  providers: [SearchService, SearchRunner, SearchTracker]
})
export class SearchModule {}
