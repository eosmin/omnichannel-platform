import type { ReactElement } from 'react'

import { pageTitle } from '../../page-title'
import { StoreSafetyPage } from '../safety-page'

export const generateMetadata = pageTitle('settingsSafety')

export default function Page(): ReactElement {
  return <StoreSafetyPage />
}
