import type { ReactElement } from 'react'

import { pageTitle } from '../../page-title'
import { StoreReturnsPage } from '../returns-page'

export const generateMetadata = pageTitle('settingsReturns')

export default function Page(): ReactElement {
  return <StoreReturnsPage />
}
