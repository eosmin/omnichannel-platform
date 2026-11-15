import type { ReactElement } from 'react'

import { pageTitle } from '../../page-title'
import { StoreApiKeysPage } from '../api-keys-page'

export const generateMetadata = pageTitle('settingsApiKeys')

export default function Page(): ReactElement {
  return <StoreApiKeysPage />
}
