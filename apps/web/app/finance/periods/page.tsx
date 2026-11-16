import type { ReactElement } from 'react'

import { pageTitle } from '../page-title'
import { PeriodsPage } from '../periods-page'

export const generateMetadata = pageTitle('financePeriods')

export default function FinancePeriodsPageRoute(): ReactElement {
  return <PeriodsPage />
}
