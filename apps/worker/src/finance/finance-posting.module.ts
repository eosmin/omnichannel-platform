import { Module } from '@nestjs/common'

import { LedgerModule } from '@platform/core/finance-ledger'

// The automatic entries of the books (TDD_18 §6.1): the processor of the heavy queue posts one event of one source through the
// posting service. The database, the event bus and the logger are the global modules of the worker.
@Module({
  imports: [LedgerModule],
  exports: [LedgerModule]
})
export class FinancePostingWorkerModule {}
