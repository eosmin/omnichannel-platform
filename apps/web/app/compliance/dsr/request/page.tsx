import type { ReactElement } from 'react'

import { DsrRequestForm } from '../../dsr-request-form'
import { pageTitle } from '../../page-title'

// Public and with no session: whoever has the address of a store (the key is in the fragment) can ask for their data. The headers of this path
// (`UNSUBSCRIBE_PAGE_HEADERS`, set in next.config.ts) say `no-referrer`, `no-store` and `noindex`
export const generateMetadata = pageTitle('dsrRequest')

export default function DsrRequestPage(): ReactElement {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4">
      <DsrRequestForm />
    </main>
  )
}
