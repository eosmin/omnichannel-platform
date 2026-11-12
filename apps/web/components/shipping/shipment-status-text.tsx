'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { ShipmentStatus } from '@platform/core/domain'

import { isKnown } from '../../lib/shipping/known-value'

// A state of a server newer than this page is not one of ours: it draws as "unknown", never as an empty cell
export function ShipmentStatusText({ status }: { status: string }): ReactElement {
  const t = useTranslations('orders.bulk')
  const tReport = useTranslations('orders.bulk.report')
  return (
    <>
      {isKnown(ShipmentStatus, status)
        ? t(`shipmentStatus.${status}` as 'shipmentStatus.failed')
        : tReport('unknown')}
    </>
  )
}
