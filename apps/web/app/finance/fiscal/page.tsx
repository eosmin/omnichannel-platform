import type { ReactElement } from 'react'

import { FiscalPage } from '../fiscal-page'
import { pageTitle } from '../page-title'

export const generateMetadata = pageTitle('financeFiscal')

export default function FinanceFiscalPageRoute(): ReactElement {
  return <FiscalPage />
}
