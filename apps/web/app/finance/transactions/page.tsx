import type { ReactElement } from 'react'

import { pageTitle } from '../page-title'
import { TransactionsPage } from '../transactions-page'

export const generateMetadata = pageTitle('financeTransactions')

export default function FinanceTransactionsPageRoute(): ReactElement {
  return <TransactionsPage />
}
