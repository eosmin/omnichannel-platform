import type { ReactElement } from 'react'

import { pageTitle } from '../../page-title'
import { StoreBusinessHoursPage } from '../pages'

export const generateMetadata = pageTitle('settingsBusinessHours')

export default function Page(): ReactElement {
  return <StoreBusinessHoursPage />
}
