import type { ReactElement } from 'react'

import { pageTitle } from '../../page-title'
import { PurchaseOrderPage } from '../../purchase-order-page'

export const generateMetadata = pageTitle('financePurchase')

export default function FinancePurchasePageRoute(): ReactElement {
  return <PurchaseOrderPage />
}
