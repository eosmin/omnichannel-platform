'use client'

import Link from 'next/link'
import type { ReactElement, ReactNode } from 'react'

import { orderHrefOf } from '../../lib/finance/order-link'
import { useProfile } from '../../lib/use-profile'

// A link to the order that made a book entry or a fiscal document, shown only to who may read the orders of its store
export function OrderLink({
  storeId,
  orderId,
  fallback = null,
  children
}: {
  storeId: string | null
  orderId: string | null
  // What stands in its place for who may not read the orders of the store
  fallback?: ReactNode
  children: ReactNode
}): ReactElement {
  const profile = useProfile()
  const href = orderHrefOf(profile.data?.memberships ?? [], storeId, orderId)
  if (href === null) return <>{fallback}</>
  return (
    <Link
      href={href}
      className="text-primary underline underline-offset-2"
      data-testid="finance-order-link"
    >
      {children}
    </Link>
  )
}
