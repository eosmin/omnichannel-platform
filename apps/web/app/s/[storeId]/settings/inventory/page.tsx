import type { ReactElement } from 'react'

import { pageTitle } from '../../page-title'
import { StoreInventoryPage } from '../inventory-page'

export const generateMetadata = pageTitle('settingsInventory')

export default function Page(): ReactElement {
  return <StoreInventoryPage />
}
