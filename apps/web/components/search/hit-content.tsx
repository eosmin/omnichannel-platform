'use client'

import { MessageSquare, Package, ShoppingBag, User } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import type { ReactElement, ReactNode } from 'react'

import { SearchEntities } from '@platform/core/domain'

import { customerListLabel } from '../../lib/customers/customer-name'
import { orderStatusKey } from '../../lib/orders/order-status'
import { formatCents } from '../../lib/products/money'
import type { SearchHit } from '../../lib/search/hits'
import { snippetParts } from '../../lib/search/snippet'
import { cn } from '../../lib/utils'

const ICON_CLASS = 'text-muted-foreground size-4 shrink-0'

// What one hit shows, the same in the palette and on the results page: a mark for the kind, the main line and a
// quieter second one. Everything that came from the customer is drawn as text.
export function HitContent({ item }: { item: SearchHit }): ReactElement {
  const t = useTranslations('search.hit')
  const tOrders = useTranslations('orders')
  const format = useFormatter()
  const unnamed = t('unnamedCustomer')

  switch (item.entity) {
    case SearchEntities.CUSTOMERS: {
      const { hit } = item
      const label = customerListLabel(hit)
      const second = [hit.email, hit.phone].filter(
        (value): value is string => value !== null && value !== label
      )
      return (
        <HitLayout icon={<User className={ICON_CLASS} aria-hidden />} title={label ?? unnamed}>
          {second.length > 0 ? second.join(' · ') : null}
        </HitLayout>
      )
    }
    case SearchEntities.ORDERS: {
      const { hit } = item
      const statusKey = orderStatusKey(hit.status)
      const status =
        statusKey === null ? tOrders('list.unknownStatus') : tOrders(`status.${statusKey}`)
      return (
        <HitLayout
          icon={<ShoppingBag className={ICON_CLASS} aria-hidden />}
          title={t('order', { number: hit.orderNumber })}
        >
          {[
            hit.customerName ?? unnamed,
            status,
            format.number(hit.totalCents / 100, { style: 'currency', currency: hit.currency })
          ]
            .filter(Boolean)
            .join(' · ')}
        </HitLayout>
      )
    }
    case SearchEntities.PRODUCTS: {
      const { hit } = item
      const variant = hit.matchedVariant
      return (
        <HitLayout icon={<Package className={ICON_CLASS} aria-hidden />} title={hit.name}>
          {[
            variant?.name ?? null,
            variant?.sku ?? hit.sku,
            formatCents(format, variant?.effectivePriceCents ?? hit.priceCents),
            hit.active ? null : t('archived')
          ]
            .filter(Boolean)
            .join(' · ')}
        </HitLayout>
      )
    }
    case SearchEntities.MESSAGES: {
      const { hit } = item
      return (
        <HitLayout
          icon={<MessageSquare className={ICON_CLASS} aria-hidden />}
          title={hit.customerName ?? unnamed}
          isMultiline
        >
          <span className="line-clamp-2">
            {snippetParts(hit.snippet).map((part, index) =>
              part.isMatch ? (
                <mark
                  key={index}
                  className="text-foreground rounded-sm bg-yellow-200/70 px-0.5 dark:bg-yellow-500/30"
                >
                  {part.text}
                </mark>
              ) : (
                <span key={index}>{part.text}</span>
              )
            )}
          </span>
        </HitLayout>
      )
    }
  }
}

function HitLayout({
  icon,
  title,
  children,
  isMultiline = false
}: {
  icon: ReactElement
  title: string
  children: ReactNode
  isMultiline?: boolean
}): ReactElement {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <span className="mt-0.5">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{title}</div>
        {children === null || children === '' ? null : (
          <div className={cn('text-muted-foreground text-xs', !isMultiline && 'truncate')}>
            {children}
          </div>
        )}
      </div>
    </div>
  )
}
