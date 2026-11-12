'use client'

import type { ReactElement } from 'react'

import { ClientPermissions } from '@platform/core/auth'

import { useStore } from '../../components/providers/store-context'
import { CarriersPanel } from '../../components/settings/carriers-panel'
import { PermissionDenied } from '../../components/settings/states'

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
