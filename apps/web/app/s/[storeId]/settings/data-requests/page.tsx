import type { ReactElement } from 'react'

import { pageTitle } from '../../page-title'
import { StoreDataRequestsPage } from '../data-requests-page'

export const generateMetadata = pageTitle('settingsDataRequests')

export default function Page(): ReactElement {
  return <StoreDataRequestsPage />
}
