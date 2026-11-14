import type { ReactElement } from 'react'

import { pageTitle } from '../../page-title'
import { AnalyticsReportsPage } from '../pages'

export const generateMetadata = pageTitle('analyticsReports')

export default function Page(): ReactElement {
  return <AnalyticsReportsPage />
}
