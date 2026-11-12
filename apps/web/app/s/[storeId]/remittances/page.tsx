import type { ReactElement } from 'react'

import { StoreRemittancesPage } from '../../store-remittances-page'
import { pageTitle } from '../page-title'

export const generateMetadata = pageTitle('remittances')

export default function Page(): ReactElement {
  return <StoreRemittancesPage />
}
