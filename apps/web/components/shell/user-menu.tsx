'use client'

import { CircleUser } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { lazy, type ReactElement } from 'react'

import { OnDemandMenu } from '../shared/on-demand-menu'
import { Button } from '../ui/button'

const loadPopup = () => import('./user-menu-popup')
const UserMenuPopup = lazy(loadPopup)

export function UserMenu({ name, email }: { name: string; email: string }): ReactElement {
  const t = useTranslations()
  return (
    <OnDemandMenu
      Popup={UserMenuPopup}
      preload={loadPopup}
      popupProps={{ email }}
      trigger={extra => (
        <Button variant="ghost" aria-label={t('shell.accountMenu')} {...extra}>
          <CircleUser aria-hidden />
          <span className="hidden max-w-32 truncate sm:inline">{name}</span>
        </Button>
      )}
    />
  )
}
