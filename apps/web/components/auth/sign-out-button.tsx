'use client'

import { LogOut } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { useSignOut } from '../../lib/use-sign-out'
import { Button } from '../ui/button'

export function SignOutButton({ redirectTo }: { redirectTo?: string }): ReactElement {
  const t = useTranslations()
  const { signOut, pending } = useSignOut(redirectTo)
  return (
    <Button
      variant="outline"
      disabled={pending}
      busy={pending}
      onClick={() => {
        void signOut()
      }}
    >
      {/* The label does not change while it waits: a longer one would resize the button */}
      <LogOut aria-hidden />
      {t('common.signOut')}
    </Button>
  )
}
