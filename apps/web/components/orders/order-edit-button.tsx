'use client'

import { Pencil } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import type { OrderDetailView } from '@platform/api-client'

import { canEditField } from '../../lib/orders/order-detail-rules'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

import { useOrderDrawer } from './order-drawer-context'

// "Edit order" of the detail page: it opens the drawer that changes the items, the shipping fee and the discount. It is drawn
// only when the member may edit orders and the status of the order still accepts one of the three.
export function OrderEditButton({ order }: { order: OrderDetailView }): ReactElement | null {
  const t = useTranslations('orders.edit')
  const { can } = useStore()
  const { openEdit } = useOrderDrawer()
  const isOffered = (['items', 'shipping', 'discount'] as const).some(field =>
    canEditField(order.status, field, can)
  )
  if (!isOffered) return null
  return (
    <Button type="button" variant="outline" size="sm" onClick={() => openEdit(order.id)}>
      <Pencil aria-hidden />
      {t('open')}
    </Button>
  )
}
