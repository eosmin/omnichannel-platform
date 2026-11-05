import type { ReactElement } from 'react'

import { pageTitle } from '../../page-title'
import { StoreRoutingPage } from '../pages'

export const generateMetadata = pageTitle('settingsRouting')

export default function Page(): ReactElement {
  return <StoreRoutingPage />
}
