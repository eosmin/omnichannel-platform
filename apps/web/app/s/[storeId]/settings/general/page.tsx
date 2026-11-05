import type { ReactElement } from 'react'

import { pageTitle } from '../../page-title'
import { StoreGeneralPage } from '../pages'

export const generateMetadata = pageTitle('settingsGeneral')

export default function Page(): ReactElement {
  return <StoreGeneralPage />
}
