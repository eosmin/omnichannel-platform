import type { ReactElement } from 'react'

import { AnalyticsPage } from '../../analytics-page'
import { pageTitle } from '../page-title'

export const generateMetadata = pageTitle('analytics')

export default function Page(): ReactElement {
  return <AnalyticsPage />
}
