import type { ReactElement } from 'react'

import { pageTitle } from '../page-title'
import { VatPage } from '../vat-page'

export const generateMetadata = pageTitle('financeVat')

export default function FinanceVatPageRoute(): ReactElement {
  return <VatPage />
}
