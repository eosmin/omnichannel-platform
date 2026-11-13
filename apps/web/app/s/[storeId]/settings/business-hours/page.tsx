import type { ReactElement } from 'react'

import { pageTitle } from '../../page-title'
import { StoreBusinessHoursPage } from '../business-hours-page'

export const generateMetadata = pageTitle('settingsBusinessHours')

export default function Page(): ReactElement {
  return <StoreBusinessHoursPage />
}
