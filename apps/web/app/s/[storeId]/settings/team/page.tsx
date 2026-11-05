import type { ReactElement } from 'react'

import { pageTitle } from '../../page-title'
import { StoreTeamPage } from '../pages'

export const generateMetadata = pageTitle('settingsTeam')

export default function Page(): ReactElement {
  return <StoreTeamPage />
}
