'use client'

import { CircleUser, LogOut } from 'lucide-react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { AppPaths } from '@platform/api-client'

import { useSignOut } from '../../lib/use-sign-out'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'

export function UserMenu({ name, email }: { name: string; email: string }): ReactElement {
  const t = useTranslations()
  const { signOut, pending } = useSignOut()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" aria-label={t('shell.accountMenu')}>
          <CircleUser aria-hidden />
          <span className="hidden max-w-32 truncate sm:inline">{name}</span>
        </Button>
      </DropdownMenuTrigger>
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
