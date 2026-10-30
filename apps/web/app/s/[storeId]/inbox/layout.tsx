import { type ReactElement, type ReactNode, Suspense } from 'react'

import { InboxFrame } from '../../inbox-frame'

// useSearchParams (the filters in the address) needs a boundary above it
export default function InboxLayout({ children }: { children: ReactNode }): ReactElement {
  return (
    <Suspense>
      <InboxFrame>{children}</InboxFrame>
    </Suspense>
  )
}
