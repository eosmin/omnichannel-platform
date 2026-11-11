import type { ReactElement } from 'react'

import { OrdersPage } from '../../orders-page'
import { pageTitle } from '../page-title'

export const generateMetadata = pageTitle('orders')

export default function Page(): ReactElement {
  return <OrdersPage />
}
