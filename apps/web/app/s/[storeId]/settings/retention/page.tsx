import type { ReactElement } from 'react'

import { pageTitle } from '../../page-title'
import { StoreRetentionPage } from '../retention-page'

export const generateMetadata = pageTitle('settingsRetention')

export default function Page(): ReactElement {
  return <StoreRetentionPage />
}
