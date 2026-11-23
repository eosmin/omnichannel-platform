import type { ReactElement } from 'react'

import { pageTitle } from '../../lib/page-titles'

import { UnsubscribeCard } from './unsubscribe-card'

// Public and with no session: the person comes from the link of an email. The headers of this path (`UNSUBSCRIBE_PAGE_HEADERS`) say
// `no-referrer`, `no-store` and `noindex`
export const generateMetadata = pageTitle('unsubscribe')

export default function UnsubscribePage(): ReactElement {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4">
      <UnsubscribeCard />
    </main>
  )
}
