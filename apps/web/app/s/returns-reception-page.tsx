'use client'

import type { ReactElement } from 'react'

import { ClientPermissions } from '@platform/core/auth'

import { useStore } from '../../components/providers/store-context'
import { ReceptionScreen } from '../../components/returns/reception-screen'
import { PermissionDenied } from '../../components/settings/states'

// The reception of returned packages by scanner (TDD_17 §4.16): receiving moves stock and records returns, so it asks for
// returns:manage, as the routes do
export function ReturnsReceptionPage(): ReactElement {
  const { can } = useStore()
  return can(ClientPermissions.RETURNS_MANAGE) ? (
    <ReceptionScreen />
  ) : (
    <PermissionDenied permission={ClientPermissions.RETURNS_MANAGE} />
  )
}
