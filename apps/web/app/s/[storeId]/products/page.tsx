import type { ReactElement } from 'react'

import { ProductsPage } from '../../products-page'
import { pageTitle } from '../page-title'

export const generateMetadata = pageTitle('products')

export default function Page(): ReactElement {
  return <ProductsPage />
}
