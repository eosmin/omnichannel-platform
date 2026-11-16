import type { ReactElement } from 'react'

import { AgingPage } from '../aging-page'
import { pageTitle } from '../page-title'

export const generateMetadata = pageTitle('financeAging')

export default function FinanceAgingPageRoute(): ReactElement {
  return <AgingPage />
}
