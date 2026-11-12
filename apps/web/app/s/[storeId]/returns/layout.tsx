import type { ReactElement, ReactNode } from 'react'

import { ReturnsLayout } from './pages'

export default function Layout({ children }: { children: ReactNode }): ReactElement {
  return <ReturnsLayout>{children}</ReturnsLayout>
}
