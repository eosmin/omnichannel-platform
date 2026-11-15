import { Module } from '@nestjs/common'

import { LedgerModule } from '@platform/core/finance-ledger'
import { InventoryModule as InventoryEngineModule } from '@platform/core/inventory'

import { TenancyModule } from '../tenancy'

import { PayablesService } from './payables.service'
import { PurchaseOrdersController } from './purchase-orders.controller'
import { PurchaseOrdersService } from './purchase-orders.service'
import { PurchaseReceivingService } from './purchase-receiving.service'
import { SupplierPaymentsService } from './supplier-payments.service'
import { SuppliersController } from './suppliers.controller'
import { SuppliersService } from './suppliers.service'

// Suppliers, purchase orders, their receipts and what is paid for them (TDD_18 §2.7, Step 4B.5). The stock a receipt raises is written by
// InventoryService and the entries by LedgerService (the only writers of their ledgers); the database, audit and event-bus modules are the
// global ones of the app.
@Module({
  imports: [InventoryEngineModule, LedgerModule, TenancyModule],
  controllers: [SuppliersController, PurchaseOrdersController],
  providers: [
    SuppliersService,
    PurchaseOrdersService,
    PurchaseReceivingService,
    PayablesService,
    SupplierPaymentsService
  ]
})
export class PurchasesModule {}
