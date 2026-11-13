import type { ReactElement } from 'react'

import { pageTitle } from '../../page-title'
import { StoreInboxPage } from '../inbox-page'

export const generateMetadata = pageTitle('settingsInbox')

export default function Page(): ReactElement {
  return <StoreInboxPage />
}
