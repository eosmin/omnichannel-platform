import { Module } from '@nestjs/common'

import { FinanceCloseGuard } from './finance-close-guard'
import { FinancePostingService } from './finance-posting.service'
import { FinanceSweepService } from './finance-sweep.service'
import { LedgerService } from './ledger.service'

// LedgerService is a provider of the api and of the worker: it relies on the global database and event-bus modules of the
// app, like InventoryService.
@Module({
  providers: [LedgerService, FinancePostingService, FinanceSweepService, FinanceCloseGuard],
  exports: [LedgerService, FinancePostingService, FinanceSweepService, FinanceCloseGuard]
})
export class LedgerModule {}
