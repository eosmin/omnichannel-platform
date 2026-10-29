import type { ReactElement } from 'react'

import { VerifyMagicLink } from '../verify-magic-link'

export default function VerifyPage(): ReactElement {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4">
      <VerifyMagicLink />
    </main>
  )
}
