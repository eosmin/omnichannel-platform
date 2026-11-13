import type { ReactElement } from 'react'

import { pageTitle } from '../../page-title'
import { StoreOrderTemplatesPage } from '../order-templates-page'

export const generateMetadata = pageTitle('settingsOrderTemplates')

export default function Page(): ReactElement {
  return <StoreOrderTemplatesPage />
}
