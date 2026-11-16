import type { ReactElement } from 'react'

import { pageTitle } from '../page-title'
import { StatementsPage } from '../statements-page'

export const generateMetadata = pageTitle('financeStatements')

export default function FinanceStatementsPageRoute(): ReactElement {
  return <StatementsPage />
}
