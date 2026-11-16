import type { ReactElement } from 'react'

import { pageTitle } from '../page-title'
import { PayablesPage } from '../payables-page'

export const generateMetadata = pageTitle('financePayables')

export default function FinancePayablesPageRoute(): ReactElement {
  return <PayablesPage />
}
