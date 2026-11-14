'use client'

import type { ReactElement } from 'react'

import type { OrderSummaryView, ShipmentSummaryView } from '@platform/api-client'
import type { Permission } from '@platform/core/auth'

import { availabilityOf, type BulkConnection } from '../../lib/orders/order-bulk'
import { useOrderBulk } from '../../lib/orders/use-order-bulk'

import { OrderBulkBar } from './order-bulk-bar'
import { OrderBulkReport } from './order-bulk-report'

// The bar over the ticked rows with the report of what its actions did. One chunk, loaded the first time a row is ticked:
// the actions, their requests and their reports are not part of the script of the orders page. The report lives here, so
// ticking nothing again closes it.
export function OrderBulkPanel({
  storeId,
  selectedIds,
  rows,
  rowsById,
  guides,
  connections,
  can,
  onClear
}: {
  storeId: string
  selectedIds: readonly string[]
  rows: readonly OrderSummaryView[]
  rowsById: ReadonlyMap<string, OrderSummaryView>
  guides: ReadonlyMap<string, ShipmentSummaryView[]>
  connections: readonly BulkConnection[]
  can: (permission: Permission) => boolean
  onClear: () => void
}): ReactElement {
  const input = { selectedIds, rows, guides, connections, can }
  const bulk = useOrderBulk(storeId, input)
  return (
    <>
      <OrderBulkBar
        storeId={storeId}
        bulk={bulk}
        availability={availabilityOf(input)}
        selectedCount={selectedIds.length}
        connections={connections}
        onClear={onClear}
      />
      {bulk.report !== null || bulk.failure !== null ? (
        <OrderBulkReport
          report={bulk.report}
          failure={bulk.failure}
          rows={rowsById}
          guides={guides}
          onClose={bulk.dismiss}
        />
      ) : null}
    </>
  )
}
