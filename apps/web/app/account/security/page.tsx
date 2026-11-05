import type { ReactElement } from 'react'

import { pageTitle } from '../page-title'
import { SecurityPage } from '../security-page'

export const generateMetadata = pageTitle('accountSecurity')

export default function Page(): ReactElement {
  return <SecurityPage />
}
