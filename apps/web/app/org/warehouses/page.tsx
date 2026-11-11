import type { ReactElement } from 'react'

import { pageTitle } from '../page-title'
import { WarehousesPage } from '../warehouses-page'

export const generateMetadata = pageTitle('orgWarehouses')

export default function OrgWarehousesPage(): ReactElement {
  return <WarehousesPage />
}
