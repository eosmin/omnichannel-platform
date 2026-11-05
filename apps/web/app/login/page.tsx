import type { ReactElement } from 'react'

import { LoginForm } from '../../components/auth/login-form'
import { pageTitle } from '../../lib/page-titles'

export const generateMetadata = pageTitle('login')

export default function LoginPage(): ReactElement {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4">
      <LoginForm />
    </main>
  )
}
