import type { ReactElement } from 'react'

import { pageTitle } from '../../page-title'
import { StoreRemittancePage } from '../pages'

export const generateMetadata = pageTitle('remittances')

export default function Page(): ReactElement {
  return <StoreRemittancePage />
}
