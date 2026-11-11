import type { ReactElement } from 'react'

import { StockPage } from '../../stock-page'
import { pageTitle } from '../page-title'

export const generateMetadata = pageTitle('inventory')

export default function Page(): ReactElement {
  return <StockPage />
}
