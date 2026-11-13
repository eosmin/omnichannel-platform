import type { ReactElement } from 'react'

import { pageTitle } from '../../page-title'
import { StoreChannelsPage } from '../channels-page'

export const generateMetadata = pageTitle('settingsChannels')

export default function Page(): ReactElement {
  return <StoreChannelsPage />
}
