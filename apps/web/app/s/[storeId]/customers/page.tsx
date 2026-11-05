import type { ReactElement } from 'react'

import { CustomersPage } from '../../customers-page'
import { pageTitle } from '../page-title'

export const generateMetadata = pageTitle('customers')

export default function Page(): ReactElement {
  return <CustomersPage />
}
