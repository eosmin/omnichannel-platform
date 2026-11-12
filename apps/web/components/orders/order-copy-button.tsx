'use client'

import { Copy } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { ClientPermissions } from '@platform/core/auth'

import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

import { useOrderDrawer } from './order-drawer-context'

// "Copy order" (TDD_17 §4.3): opens the create drawer with the draft of an order that exists, at today's catalog prices
// and with a warning per line the catalog no longer sells as it was. The route reads the order and the customer, and the
// copy is an order to be made: it needs both permissions, and a member without them is not offered the button.
export function OrderCopyButton({
  orderId,
  orderNumber,
  size = 'sm',
  onOpened
}: {
  orderId: string
  orderNumber: string
  size?: 'sm' | 'default'
  onOpened?: () => void
}): ReactElement | null {
  const t = useTranslations('orders.copy')
  const { can } = useStore()
  const { openCreate } = useOrderDrawer()
  if (!can(ClientPermissions.ORDERS_VIEW) || !can(ClientPermissions.ORDERS_CREATE)) return null
  return (
    <Button
      type="button"
      variant="outline"
      size={size}
      aria-label={t('openNamed', { number: orderNumber })}
      onClick={() => {
        // The panel that holds the button closes first, then the drawer opens
        onOpened?.()
        openCreate({ copyOfOrderId: orderId })
      }}
    >
      <Copy aria-hidden />
      {t('open')}
    </Button>
  )
}
