import type { ReactElement } from 'react'

import { LoginForm } from '../../components/auth/login-form'
import { CookiePreferencesButton } from '../../components/cookie-consent/cookie-preferences-button'
import { pageTitle } from '../../lib/page-titles'

export const generateMetadata = pageTitle('login')

export default function LoginPage(): ReactElement {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4">
      <LoginForm />
      <div className="mt-6 flex justify-center">
        <CookiePreferencesButton />
      </div>
    </main>
  )
}
