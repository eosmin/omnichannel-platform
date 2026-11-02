import type { ReactElement, ReactNode } from 'react'

import { StoreSettingsLayout } from '../../store-settings-layout'

export default function Layout({ children }: { children: ReactNode }): ReactElement {
  return <StoreSettingsLayout>{children}</StoreSettingsLayout>
}
