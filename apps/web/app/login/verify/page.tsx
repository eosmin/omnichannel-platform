import type { ReactElement } from 'react'

import { pageTitle } from '../page-title'
import { VerifyMagicLink } from '../verify-magic-link'

export const generateMetadata = pageTitle('loginVerify')

export default function VerifyPage(): ReactElement {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4">
      <VerifyMagicLink />
    </main>
  )
}
