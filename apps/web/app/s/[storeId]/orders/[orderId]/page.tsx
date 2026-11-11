import type { ReactElement } from 'react'

import { pageTitle } from '../../page-title'
import { OrderDetailPage } from '../pages'

export const generateMetadata = pageTitle('orders')

export default function Page(): ReactElement {
  return <OrderDetailPage />
}
