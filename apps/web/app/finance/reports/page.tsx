import type { ReactElement } from 'react'

import { pageTitle } from '../page-title'
import { ReportsPage } from '../reports-page'

export const generateMetadata = pageTitle('financeReports')

export default function FinanceReportsPageRoute(): ReactElement {
  return <ReportsPage />
}
