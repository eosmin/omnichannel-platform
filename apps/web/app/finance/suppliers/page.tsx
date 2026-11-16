import type { ReactElement } from 'react'

import { pageTitle } from '../page-title'
import { SuppliersPage } from '../suppliers-page'

export const generateMetadata = pageTitle('financeSuppliers')

export default function FinanceSuppliersPageRoute(): ReactElement {
  return <SuppliersPage />
}
