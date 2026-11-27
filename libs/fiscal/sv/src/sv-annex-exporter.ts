import type { FiscalAnnexExporter } from '@platform/fiscal/sdk'

import { svSalesAnnexes } from './sv-annexes'
import { purchasesAnnex } from './sv-annexes-purchases'
import { SvAnnexIds } from './sv-constants'

// All the annexes of the return of El Salvador: the sales ones are made from the documents the authority accepted, the one of purchases
// from the receipts of the purchases
export const svAnnexes: FiscalAnnexExporter = {
  ids: [...svSalesAnnexes.ids, SvAnnexIds.PURCHASES],
  build: svSalesAnnexes.build,
  purchaseIds: [SvAnnexIds.PURCHASES],
  buildPurchases(id, period, purchases) {
    return id === SvAnnexIds.PURCHASES ? purchasesAnnex(period, purchases) : null
  }
}
