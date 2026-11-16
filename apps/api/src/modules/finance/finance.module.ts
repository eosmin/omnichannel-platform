import { Module } from '@nestjs/common'

import { LedgerModule } from '@platform/core/finance-ledger'
import { QueuesPlatformModule } from '@platform/core/http'

import { MediaModule } from '../media/media.module'
import { TenancyModule } from '../tenancy'

import { FinanceAccountsService } from './finance-accounts.service'
import { FinanceBankImportsService } from './finance-bank-imports.service'
import { FinanceBankProfilesService } from './finance-bank-profiles.service'
import { FinanceBankController } from './finance-bank.controller'
import { FinanceChainService } from './finance-chain.service'
import { FinanceCloseService } from './finance-close.service'
import { FinanceEntriesService } from './finance-entries.service'
import { FinanceMarginController } from './finance-margin.controller'
import { FinanceMarginService } from './finance-margin.service'
import { FinancePeriodsService } from './finance-periods.service'
import { FinancePostingListener } from './finance-posting.listener'
import { FinancePostingQueue } from './finance-posting.queue'
import { FinanceReconciliationService } from './finance-reconciliation.service'
import { FinanceReportsController } from './finance-reports.controller'
import { FinanceReportsService } from './finance-reports.service'
import { FinanceSettingsService } from './finance-settings.service'
import { FinanceSetupService } from './finance-setup.service'
import { FinanceStatementsController } from './finance-statements.controller'
import { FinanceStatementsService } from './finance-statements.service'
import { FinanceStoreTaxSettingsService } from './finance-store-tax-settings.service'
import { FinanceTaxRatesService } from './finance-tax-rates.service'
import { FinanceTransactionDocumentsService } from './finance-transaction-documents.service'
import { FinanceTransactionsController } from './finance-transactions.controller'
import { FinanceTransactionsService } from './finance-transactions.service'
import { FinanceVatReportService } from './finance-vat-report.service'
import { FinanceController } from './finance.controller'

// The routes of the books of the organization: setup, chart, maps, periods, journal, balances. The one that writes the journal
// is LedgerService of libs/core/finance; the database, audit and event-bus modules are the global ones of the app.
@Module({
  imports: [LedgerModule, MediaModule, QueuesPlatformModule, TenancyModule],
  controllers: [
    FinanceController,
    FinanceTransactionsController,
    FinanceBankController,
    FinanceReportsController,
    FinanceStatementsController,
    FinanceMarginController
  ],
  providers: [
    FinanceSetupService,
    FinanceSettingsService,
    FinanceAccountsService,
    FinancePeriodsService,
    FinanceEntriesService,
    FinanceTaxRatesService,
    FinanceStoreTaxSettingsService,
    FinanceTransactionsService,
    FinanceTransactionDocumentsService,
    FinanceVatReportService,
    FinanceCloseService,
    FinanceReportsService,
    FinanceStatementsService,
    FinanceMarginService,
    FinanceChainService,
    FinanceBankProfilesService,
    FinanceBankImportsService,
    FinanceReconciliationService,
    FinancePostingListener,
    FinancePostingQueue
  ],
  exports: [LedgerModule]
})
export class FinanceModule {}
