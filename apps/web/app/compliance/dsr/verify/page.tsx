import type { ReactElement } from 'react'

import { DsrVerifyCard } from '../../dsr-verify-card'
import { pageTitle } from '../../page-title'

// Public and with no session: the person comes from the link of the verification mail of a data request. The headers of this path
// (`UNSUBSCRIBE_PAGE_HEADERS`, set in next.config.ts) say `no-referrer`, `no-store` and `noindex`
export const generateMetadata = pageTitle('dsrVerify')

export default function DsrVerifyPage(): ReactElement {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4">
      <DsrVerifyCard />
    </main>
  )
}
