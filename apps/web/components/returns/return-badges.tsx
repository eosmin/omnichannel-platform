import { Check, CheckCheck, CircleSlash, Clock, PackageCheck, Truck, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { OrderReturnStatus } from '@platform/core/domain'

const ICONS = {
  [OrderReturnStatus.REQUESTED]: Clock,
  [OrderReturnStatus.APPROVED]: Check,
  [OrderReturnStatus.IN_TRANSIT]: Truck,
  [OrderReturnStatus.RECEIVED]: PackageCheck,
  [OrderReturnStatus.COMPLETED]: CheckCheck,
  [OrderReturnStatus.REJECTED]: X,
  [OrderReturnStatus.CANCELLED]: CircleSlash
} as const

// The state of a return, in words and with an icon (never colour alone); the words are the ones of the order's Returns panel
export function ReturnStatusText({ status }: { status: OrderReturnStatus }): ReactElement {
  const t = useTranslations('orders.detail.returns.status')
  const Icon = ICONS[status]
  return (
    <span className="inline-flex items-center gap-1 text-sm">
      <Icon aria-hidden className="size-4" />
      {t(status)}
    </span>
  )
}
