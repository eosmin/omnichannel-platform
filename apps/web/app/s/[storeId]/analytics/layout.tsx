import type { ReactElement, ReactNode } from 'react'

import { AnalyticsLayout } from '../../analytics-layout'

export default function Layout({ children }: { children: ReactNode }): ReactElement {
  return <AnalyticsLayout>{children}</AnalyticsLayout>
}
