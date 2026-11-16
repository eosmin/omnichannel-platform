import { Module } from '@nestjs/common'

import { LedgerModule } from '@platform/core/finance-ledger'
import { QueuesPlatformModule } from '@platform/core/http'

import { FinanceChainChecker } from './finance-chain-checker.service'
import { FinanceReconciler } from './finance-reconciler.service'

// The automatic entries of the books (TDD_18 §6.1): the processor of the heavy queue posts one event of one source through the
// posting service. The database, the event bus and the logger are the global modules of the worker.
@Module({
  // The queues: the daily check asks the heavy queue for the posting jobs it finds
  imports: [LedgerModule, QueuesPlatformModule],
  providers: [FinanceReconciler, FinanceChainChecker],
  exports: [LedgerModule, FinanceReconciler, FinanceChainChecker]
})
export class FinancePostingWorkerModule {}
