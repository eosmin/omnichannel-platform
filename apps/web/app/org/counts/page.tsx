import type { ReactElement } from 'react'

import { CountsPage } from '../counts-page'
import { pageTitle } from '../page-title'

export const generateMetadata = pageTitle('orgCounts')

export default function OrgCountsPage(): ReactElement {
  return <CountsPage />
}
