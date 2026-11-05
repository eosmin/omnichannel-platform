import type { ReactElement } from 'react'

import { pageTitle } from '../../page-title'
import { StoreTagsPage } from '../pages'

export const generateMetadata = pageTitle('settingsTags')

export default function Page(): ReactElement {
  return <StoreTagsPage />
}
