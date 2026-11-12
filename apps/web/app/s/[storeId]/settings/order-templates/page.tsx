import type { ReactElement } from 'react'

import { pageTitle } from '../../page-title'
import { StoreOrderTemplatesPage } from '../pages'

export const generateMetadata = pageTitle('settingsOrderTemplates')

export default function Page(): ReactElement {
  return <StoreOrderTemplatesPage />
}
