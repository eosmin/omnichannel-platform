'use client'

import type { ReactElement, ReactNode } from 'react'

import type { FinanceSettingsView } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'

import { useFinanceSetup } from '../../lib/finance/use-finance'
import { useStore } from '../providers/store-context'
import { LoadFailed, PageLoading, PermissionDenied } from '../settings/states'

import { SetupPanel } from './setup-panel'

// What every finance page needs first: the permission to read the books, and the books themselves. A page of an organization that
// has not set them up yet shows the setup (or tells who may do it), and never an empty list that looks like a broken one.
export function FinanceGate({
  children
}: {
  children: (settings: FinanceSettingsView) => ReactNode
}): ReactElement {
  const { storeId, can } = useStore()
  const allowed = can(ClientPermissions.FINANCE_VIEW)
  const setup = useFinanceSetup(storeId, allowed)
  if (!allowed) return <PermissionDenied permission={ClientPermissions.FINANCE_VIEW} />
  if (setup.isError) return <LoadFailed error={setup.error} onRetry={() => void setup.refetch()} />
  if (setup.data === undefined) return <PageLoading />
  if (!setup.data.ready || setup.data.settings === null) return <SetupPanel state={setup.data} />
  return <>{children(setup.data.settings)}</>
}
