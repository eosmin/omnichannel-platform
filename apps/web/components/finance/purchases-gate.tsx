'use client'

import type { ReactElement, ReactNode } from 'react'

import type { Permission } from '@platform/core/auth'

import { useStore } from '../providers/store-context'
import { PermissionDenied } from '../settings/states'

// What every purchase page needs first: one of the permissions that open it. The books are not asked for here: suppliers, orders and
// payables are the api's own routes (finance:manage_purchases, finance:move_money), and what a form needs of the chart (an account, a
// tax rate) is read only by who holds finance:view, each form saying so when the person does not.
export function PurchasesGate({
  anyOf,
  children
}: {
  anyOf: readonly Permission[]
  children: ReactNode
}): ReactElement {
  const { can } = useStore()
  if (!anyOf.some(permission => can(permission))) return <PermissionDenied anyOf={anyOf} />
  return <>{children}</>
}
