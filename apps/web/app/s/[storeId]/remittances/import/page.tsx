import type { ReactElement } from 'react'

import { pageTitle } from '../../page-title'
import { StoreRemittanceImportPage } from '../pages'

export const generateMetadata = pageTitle('remittanceImport')

export default function Page(): ReactElement {
  return <StoreRemittanceImportPage />
}
