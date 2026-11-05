import type { ReactElement } from 'react'

import { StoreSettingsHome } from '../../store-settings-layout'
import { pageTitle } from '../page-title'

export const generateMetadata = pageTitle('settings')

export default function Page(): ReactElement {
  return <StoreSettingsHome />
}
