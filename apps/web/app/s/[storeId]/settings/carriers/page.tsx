import type { ReactElement } from 'react'

import { pageTitle } from '../../page-title'
import { StoreCarriersPage } from '../pages'

export const generateMetadata = pageTitle('settingsCarriers')

export default function Page(): ReactElement {
  return <StoreCarriersPage />
}
