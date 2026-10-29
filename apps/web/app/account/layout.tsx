import type { ReactElement, ReactNode } from 'react'

import { AccountShell } from './account-shell'

export default function AccountLayout({ children }: { children: ReactNode }): ReactElement {
  return <AccountShell>{children}</AccountShell>
}
