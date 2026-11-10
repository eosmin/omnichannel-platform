import { Module } from '@nestjs/common'

import { InventoryService } from './inventory.service'

// InventoryService is a provider of the api and of the worker: it relies on the global database, event-bus and logger
// modules of the app, like the rest of libs/core.
@Module({
  providers: [InventoryService],
  exports: [InventoryService]
})
export class InventoryModule {}
