import type { ReactElement } from 'react'

import { pageTitle } from '../page-title'
import { PurchasesPage } from '../purchases-page'

export const generateMetadata = pageTitle('financePurchases')

export default function FinancePurchasesPageRoute(): ReactElement {
  return <PurchasesPage />
}
