import { Module } from '@nestjs/common'

import { AuditColdExporter } from './audit-cold-exporter.service'
import { ErasedCustomerData } from './erased-customer-data.service'
import { ErasedCustomerSweep } from './erased-customer-sweep.service'
import { PlatformCleaner } from './platform-cleaner.service'
import { StoreRetentionEnforcer } from './store-retention-enforcer.service'

// The three jobs of the retention (TDD_05 §9.3 and §10.4). The database, the storage and the logger come from the platform
// module of the worker. The processors of the heavy and exports queues run the first and the last, the schedulers of
// the worker module run the second and queue the others.
@Module({
  providers: [
    StoreRetentionEnforcer,
    PlatformCleaner,
    AuditColdExporter,
    ErasedCustomerData,
    ErasedCustomerSweep
  ],
  exports: [
    StoreRetentionEnforcer,
    PlatformCleaner,
    AuditColdExporter,
    ErasedCustomerData,
    ErasedCustomerSweep
  ]
})
export class RetentionWorkerModule {}
