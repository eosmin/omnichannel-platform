import type { ReactElement } from 'react'

import { LoginForm } from '../../components/auth/login-form'

export default function LoginPage(): ReactElement {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4">
      <LoginForm />
    </main>
  )
}
