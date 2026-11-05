import type { ReactElement } from 'react'

import { pageTitle } from '../page-title'
import { PreferencesPage } from '../preferences-page'

export const generateMetadata = pageTitle('accountPreferences')

export default function Page(): ReactElement {
  return <PreferencesPage />
}
