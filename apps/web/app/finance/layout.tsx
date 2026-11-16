import type { ReactElement, ReactNode } from 'react'

import { FinanceShell } from './finance-shell'

export default function FinanceLayout({ children }: { children: ReactNode }): ReactElement {
  return <FinanceShell>{children}</FinanceShell>
}
