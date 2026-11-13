import type { ReactElement } from 'react'

import { pageTitle } from '../../page-title'
import { StoreRoutingPage } from '../routing-page'

export const generateMetadata = pageTitle('settingsRouting')

export default function Page(): ReactElement {
  return <StoreRoutingPage />
}
