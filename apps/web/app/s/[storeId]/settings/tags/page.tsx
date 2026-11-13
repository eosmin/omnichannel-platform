import type { ReactElement } from 'react'

import { pageTitle } from '../../page-title'
import { StoreTagsPage } from '../tags-page'

export const generateMetadata = pageTitle('settingsTags')

export default function Page(): ReactElement {
  return <StoreTagsPage />
}
