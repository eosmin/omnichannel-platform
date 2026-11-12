'use client'

import dynamic from 'next/dynamic'
import type { ReactElement } from 'react'

import { ClientPermissions } from '@platform/core/auth'

import { useStore } from '../../components/providers/store-context'
import { PageLoading, PermissionDenied } from '../../components/settings/states'

// The page is downloaded when it is opened: the settings pages share one barrel (`settings/pages.ts`), and a static import
// here would put the screens of the carriers in the script budget of every other settings page
const CarriersPanel = dynamic(
  () => import('../../components/settings/carriers-panel').then(module => module.CarriersPanel),
  { ssr: false, loading: () => <PageLoading /> }
)

// Settings → Store → Carriers (TDD_17 §6): the api asks for shipping:view to read the connections and
// settings:manage_carriers to change them, so the page opens with the first and its controls need the second
export function StoreCarriersPage(): ReactElement {
  const { can } = useStore()
  return can(ClientPermissions.SHIPPING_VIEW) ? (
    <CarriersPanel />
  ) : (
    <PermissionDenied permission={ClientPermissions.SHIPPING_VIEW} />
  )
}
