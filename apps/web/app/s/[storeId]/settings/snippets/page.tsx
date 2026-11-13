import type { ReactElement } from 'react'

import { pageTitle } from '../../page-title'
import { StoreSnippetsPage } from '../snippets-page'

export const generateMetadata = pageTitle('settingsSnippets')

export default function Page(): ReactElement {
  return <StoreSnippetsPage />
}
