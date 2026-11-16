import type { ReactElement } from 'react'

import { MarginPage } from '../margin-page'
import { pageTitle } from '../page-title'

export const generateMetadata = pageTitle('financeMargin')

export default function FinanceMarginPageRoute(): ReactElement {
  return <MarginPage />
}
