import type { ReactElement } from 'react'

import { pageTitle } from '../../page-title'
import { StoreGeneralPage } from '../general-page'

export const generateMetadata = pageTitle('settingsGeneral')

export default function Page(): ReactElement {
  return <StoreGeneralPage />
}
