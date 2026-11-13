import type { ReactElement } from 'react'

import { pageTitle } from '../../page-title'
import { StorePluginsPage } from '../plugins-page'

export const generateMetadata = pageTitle('settingsPlugins')

export default function Page(): ReactElement {
  return <StorePluginsPage />
}
