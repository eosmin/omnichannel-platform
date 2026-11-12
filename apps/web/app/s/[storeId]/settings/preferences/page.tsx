import type { ReactElement } from 'react'

import { pageTitle } from '../../page-title'
import { StorePreferencesPage } from '../pages'

export const generateMetadata = pageTitle('settingsPreferences')

export default function Page(): ReactElement {
  return <StorePreferencesPage />
}
