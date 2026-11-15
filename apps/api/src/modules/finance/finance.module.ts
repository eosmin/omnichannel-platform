import { Module } from '@nestjs/common'

import { LedgerModule } from '@platform/core/finance-ledger'

import { TenancyModule } from '../tenancy'

import { FinanceAccountsService } from './finance-accounts.service'
import { FinanceEntriesService } from './finance-entries.service'
import { FinancePeriodsService } from './finance-periods.service'
import { FinanceSettingsService } from './finance-settings.service'
import { FinanceSetupService } from './finance-setup.service'
import { FinanceController } from './finance.controller'

// The routes of the books of the organization: setup, chart, maps, periods, journal, balances. The one that writes the journal
// is LedgerService of libs/core/finance; the database, audit and event-bus modules are the global ones of the app.
@Module({
  imports: [LedgerModule, TenancyModule],
  controllers: [FinanceController],
  providers: [
    FinanceSetupService,
    FinanceSettingsService,
    FinanceAccountsService,
    FinancePeriodsService,
    FinanceEntriesService
  ],
  exports: [LedgerModule]
})
export class FinanceModule {}
