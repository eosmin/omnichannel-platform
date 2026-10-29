import type { ReactElement, ReactNode } from 'react'

import { OrgShell } from './org-shell'

export default function OrgLayout({ children }: { children: ReactNode }): ReactElement {
  return <OrgShell>{children}</OrgShell>
}
