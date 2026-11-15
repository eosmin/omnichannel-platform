import { Module } from '@nestjs/common'

import { FinancePostingService } from './finance-posting.service'
import { LedgerService } from './ledger.service'

// LedgerService is a provider of the api and of the worker: it relies on the global database and event-bus modules of the
// app, like InventoryService.
@Module({
  providers: [LedgerService, FinancePostingService],
  exports: [LedgerService, FinancePostingService]
})
export class LedgerModule {}
