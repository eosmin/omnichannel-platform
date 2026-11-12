import type { ReactElement } from 'react'

import { StoreShipmentsPage } from '../../store-shipments-page'
import { pageTitle } from '../page-title'

export const generateMetadata = pageTitle('shipments')

export default function Page(): ReactElement {
  return <StoreShipmentsPage />
}
