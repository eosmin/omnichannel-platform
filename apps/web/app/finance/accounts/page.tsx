import type { ReactElement } from 'react'

import { AccountsPage } from '../accounts-page'
import { pageTitle } from '../page-title'

export const generateMetadata = pageTitle('financeAccounts')

export default function FinanceAccountsPageRoute(): ReactElement {
  return <AccountsPage />
}
