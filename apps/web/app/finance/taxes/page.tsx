import type { ReactElement } from 'react'

import { pageTitle } from '../page-title'
import { TaxesPage } from '../taxes-page'

export const generateMetadata = pageTitle('financeTaxes')

export default function FinanceTaxesPageRoute(): ReactElement {
  return <TaxesPage />
}
