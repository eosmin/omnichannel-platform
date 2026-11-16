import type { ReactElement } from 'react'

import { pageTitle } from '../page-title'
import { ReconciliationPage } from '../reconciliation-page'

export const generateMetadata = pageTitle('financeReconciliation')

export default function FinanceReconciliationPageRoute(): ReactElement {
  return <ReconciliationPage />
}
