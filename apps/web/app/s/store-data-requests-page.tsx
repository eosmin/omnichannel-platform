'use client'

import type { ReactElement } from 'react'

import { ClientPermissions } from '@platform/core/auth'

import { useStore } from '../../components/providers/store-context'
import { DsrQueuePanel } from '../../components/settings/dsr-queue-panel'
import { PermissionDenied } from '../../components/settings/states'

// Settings → Store → Data requests (TDD_05 §10.2). The api asks customers:dsr_review for the queue, for one request and for every decision.
export function StoreDataRequestsPage(): ReactElement {
  const { can, storeId } = useStore()
  return can(ClientPermissions.CUSTOMERS_DSR_REVIEW) ? (
    // A fresh panel per store: the filters chosen for one store do not carry to the next
    <DsrQueuePanel key={storeId} />
  ) : (
    <PermissionDenied permission={ClientPermissions.CUSTOMERS_DSR_REVIEW} />
  )
}
