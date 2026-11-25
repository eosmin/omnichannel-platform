import type { ReactElement } from 'react'

import { DsrExportCard } from '../../dsr-export-card'
import { pageTitle } from '../../page-title'

// Public and with no session: the person comes from the link of the closing mail of an access or portability request. The headers of this path
// (`UNSUBSCRIBE_PAGE_HEADERS`, set in next.config.ts) say `no-referrer`, `no-store` and `noindex`
export const generateMetadata = pageTitle('dsrExport')

export default function DsrExportPage(): ReactElement {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4">
      <DsrExportCard />
    </main>
  )
}
