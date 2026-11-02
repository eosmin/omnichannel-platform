'use client'

import { useRouter } from 'next/navigation'
import { type ReactElement, type ReactNode, useEffect } from 'react'

import { useStore } from '../../components/providers/store-context'
import { SettingsFrame } from '../../components/settings/settings-frame'
import { PermissionDenied } from '../../components/settings/states'
import {
  firstVisibleHref,
  SettingsAreas,
  storeSettingsEntries,
  visibleEntries
} from '../../lib/settings/entries'

// /s/[storeId]/settings/*: the navigation lists only the pages the person may open
export function StoreSettingsLayout({ children }: { children: ReactNode }): ReactElement {
  const { storeId, can } = useStore()
  const entries = visibleEntries(storeSettingsEntries(storeId), can)
  return (
    <SettingsFrame area={SettingsAreas.STORE} entries={entries}>
      {children}
    </SettingsFrame>
  )
}

// /s/[storeId]/settings has no content of its own: it opens the first page the person may see
export function StoreSettingsHome(): ReactElement {
  const { storeId, can } = useStore()
  const router = useRouter()
  const href = firstVisibleHref(storeSettingsEntries(storeId), can)
  useEffect(() => {
    if (href !== null) router.replace(href)
  }, [href, router])
  return href === null ? <PermissionDenied /> : <></>
}
