import type { ReactElement } from 'react'

import { FiscalIssuerPage } from '../../fiscal-issuer-page'
import { pageTitle } from '../../page-title'

export const generateMetadata = pageTitle('financeFiscalIssuer')

export default function FinanceFiscalIssuerPageRoute(): ReactElement {
  return <FiscalIssuerPage />
}
