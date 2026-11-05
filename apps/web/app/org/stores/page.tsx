import type { ReactElement } from 'react'

import { pageTitle } from '../page-title'
import { StoresList } from '../stores-list'

export const generateMetadata = pageTitle('orgStores')

export default function StoresPage(): ReactElement {
  return <StoresList />
}
