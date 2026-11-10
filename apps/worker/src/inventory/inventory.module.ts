import { Module } from '@nestjs/common'

import { InventoryModule as InventoryEngineModule } from '@platform/core/inventory'

import { InventoryReconciler } from './inventory-reconciler.service'

// The daily reconciliation of the stock (TDD_16 §4.8). The engine of libs/core/inventory is registered here so that the
// reconciler can ask it to check a level; the database, the event bus, the metrics and the logger are the global
// modules of the worker.
@Module({
  imports: [InventoryEngineModule],
  providers: [InventoryReconciler],
  exports: [InventoryReconciler]
})
export class InventoryReconcileModule {}
