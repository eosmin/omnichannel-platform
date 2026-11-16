'use client'

import type { ReactElement, ReactNode } from 'react'

import { ClientPermissions } from '@platform/core/auth'

import { useStore } from '../providers/store-context'
import { PermissionDenied } from '../settings/states'

// What every fiscal page needs first: the permission to read the fiscal documents. The api asks for it on every call; this keeps a page
// from asking for what its person may not read.
export function FiscalGate({
  children
}: {
  children: (canManage: boolean) => ReactNode
}): ReactElement {
  const { can } = useStore()
  if (!can(ClientPermissions.FISCAL_VIEW)) {
    return <PermissionDenied permission={ClientPermissions.FISCAL_VIEW} />
  }
  return <>{children(can(ClientPermissions.FISCAL_MANAGE))}</>
}
