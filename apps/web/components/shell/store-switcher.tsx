'use client'

import { ChevronsUpDown } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { lazy, type ReactElement } from 'react'

import type { AccountMembership } from '@platform/api-client'

import { OnDemandMenu } from '../shared/on-demand-menu'
import { Button } from '../ui/button'

const loadPopup = () => import('./store-switcher-popup')
const StoreSwitcherPopup = lazy(loadPopup)

// The stores of the person, each with its name and their role there. No count of open
// conversations: it would take a call for each store (Phase 2, MVP_TRIM_CHECKLIST §10 item 39).
export function StoreSwitcher({
  memberships,
  suspendedStores = [],
  currentStoreId
}: {
  memberships: readonly AccountMembership[]
  // Stores the person belongs to and may not enter: listed, and not a way in
  suspendedStores?: readonly { storeId: string; storeName: string }[]
  currentStoreId: string | null
}): ReactElement | null {
  const t = useTranslations('shell')
  if (memberships.length === 0 && suspendedStores.length === 0) return null
  const current = memberships.find(membership => membership.storeId === currentStoreId)
  return (
    <OnDemandMenu
      Popup={StoreSwitcherPopup}
      preload={loadPopup}
      popupProps={{ memberships, suspendedStores, currentStoreId }}
      trigger={extra => (
        <Button
          variant="outline"
          aria-label={t('switchStore')}
          className="max-w-full min-w-0"
          {...extra}
        >
          <span className="max-w-40 truncate">{current?.storeName ?? t('selectStore')}</span>
          <ChevronsUpDown aria-hidden />
        </Button>
      )}
    />
  )
}
