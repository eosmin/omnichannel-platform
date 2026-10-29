'use client'

import { createContext, type ReactElement, type ReactNode, useContext, useMemo } from 'react'

import type { AccountMembership } from '@platform/api-client'
import type { Permission } from '@platform/core/auth'

export interface StoreContextValue {
  storeId: string
  storeName: string
  role: string
  // What the interface may show. The server still decides every request.
  can: (permission: Permission) => boolean
}

const StoreContext = createContext<StoreContextValue | null>(null)

export function StoreProvider({
  membership,
  children
}: {
  membership: AccountMembership
  children: ReactNode
}): ReactElement {
  const value = useMemo<StoreContextValue>(
    () => ({
      storeId: membership.storeId,
      storeName: membership.storeName,
      role: membership.role,
      can: permission => membership.permissions.includes(permission)
    }),
    [membership]
  )
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStore(): StoreContextValue {
  const value = useContext(StoreContext)
  if (value === null) throw new Error('useStore needs a StoreProvider above it')
  return value
}
