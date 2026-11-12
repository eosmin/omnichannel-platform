import type { ReactElement, ReactNode } from 'react'

import { OrderDetailLayout } from '../pages'

export default function Layout({ children }: { children: ReactNode }): ReactElement {
  return <OrderDetailLayout>{children}</OrderDetailLayout>
}
