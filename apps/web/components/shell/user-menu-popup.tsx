'use client'

import { LogOut } from 'lucide-react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { AppPaths } from '@platform/api-client'

import { useSignOut } from '../../lib/use-sign-out'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'

// The menu of the account button, downloaded when the person reaches for the button (`UserMenu`)
export default function UserMenuPopup({
  email,
  defaultOpen,
  trigger
}: {
  email: string
  defaultOpen: boolean
  trigger: ReactElement
}): ReactElement {
  const t = useTranslations()
  const { signOut, pending } = useSignOut()
  return (
    <DropdownMenu defaultOpen={defaultOpen}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{email}</DropdownMenuLabel>
        <DropdownMenuItem asChild>
          <Link href={AppPaths.account.profile}>{t('shell.account')}</Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={pending}
          onSelect={() => {
            void signOut()
          }}
        >
          <LogOut aria-hidden className="size-4" />
          {t('common.signOut')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
