import type { CursorPage } from '@platform/core/domain'

import type {
  ReceptionBatchSummaryView,
  ReceptionBatchView,
  ReceptionItemView
} from './return-reception.views'
import type { ReturnView } from './returns.views'

// What a plugin reads of the returns (Step 5.6 PR E6). The fields are named one by one, so a column added to the views of the screen
// does not reach a plugin until someone decides it should. Left out on purpose:
// - `createdBy`: the id of the person of the team who made the return or opened the batch (the team directory has no scope);
// - of a reception item, the flag on the customer (`flagCustomer`, `flagReason`, `flagApplied`) and whether the customer is flagged
//   (`customerIsCaution`): a flag is a note about a person, and who reads or sets it holds `customers:flag-caution`, a scope the
//   returns scope does not carry;
// - of a batch, `cautionPreselected`: it only steers the editor of the person who is scanning.

export type PluginReturnView = Omit<ReturnView, 'createdBy'>
export type PluginReturnPage = Omit<CursorPage<ReturnView>, 'data'> & { data: PluginReturnView[] }

export function pluginReturnView(view: ReturnView): PluginReturnView {
  return {
    id: view.id,
    orderId: view.orderId,
    orderNumber: view.orderNumber,
    type: view.type,
    reason: view.reason,
    status: view.status,
    shippingPayer: view.shippingPayer,
    replacementOrderId: view.replacementOrderId,
    returnShipmentId: view.returnShipmentId,
    refundAmountCents: view.refundAmountCents,
    notes: view.notes,
    createdAt: view.createdAt,
    receivedAt: view.receivedAt,
    lines: view.lines.map(line => ({
      id: line.id,
      orderItemId: line.orderItemId,
      productName: line.productName,
      variantName: line.variantName,
      quantity: line.quantity,
      condition: line.condition,
      restockWarehouseId: line.restockWarehouseId
    }))
  }
}

export function pluginReturnPage(page: CursorPage<ReturnView>): PluginReturnPage {
  return { ...page, data: page.data.map(pluginReturnView) }
}

const pluginCounts = (counts: ReceptionBatchSummaryView['counts']) => ({
  total: counts.total,
  received: counts.received,
  failed: counts.failed,
  pending: counts.pending
})

export type PluginReceptionBatchSummaryView = Omit<ReceptionBatchSummaryView, 'createdBy'>

export function pluginReceptionBatchSummaryView(
  view: ReceptionBatchSummaryView
): PluginReceptionBatchSummaryView {
  return {
    id: view.id,
    status: view.status,
    createdAt: view.createdAt,
    completedAt: view.completedAt,
    counts: pluginCounts(view.counts)
  }
}

export type PluginReceptionItemView = Omit<
  ReceptionItemView,
  'customerIsCaution' | 'flagCustomer' | 'flagReason' | 'flagApplied'
>
export type PluginReceptionBatchView = Omit<
  ReceptionBatchView,
  'createdBy' | 'cautionPreselected' | 'items'
> & { items: PluginReceptionItemView[] }

export function pluginReceptionItemView(item: ReceptionItemView): PluginReceptionItemView {
  return {
    id: item.id,
    shipmentId: item.shipmentId,
    guideNumber: item.guideNumber,
    shipmentStatus: item.shipmentStatus,
    orderId: item.orderId,
    orderNumber: item.orderNumber,
    orderItems: item.orderItems.map(orderItem => ({
      id: orderItem.id,
      productName: orderItem.productName,
      variantName: orderItem.variantName,
      quantity: orderItem.quantity
    })),
    reason: item.reason,
    condition: item.condition,
    note: item.note,
    lines: item.lines.map(line => ({
      orderItemId: line.orderItemId,
      quantity: line.quantity,
      condition: line.condition,
      ...(line.restockWarehouseId === undefined
        ? {}
        : { restockWarehouseId: line.restockWarehouseId })
    })),
    confirmDelivered: item.confirmDelivered,
    outcome: item.outcome,
    errorCode: item.errorCode,
    returnId: item.returnId,
    scannedAt: item.scannedAt
  }
}

export function pluginReceptionBatchView(batch: ReceptionBatchView): PluginReceptionBatchView {
  return {
    id: batch.id,
    status: batch.status,
    createdAt: batch.createdAt,
    completedAt: batch.completedAt,
    counts: pluginCounts(batch.counts),
    items: batch.items.map(pluginReceptionItemView)
  }
}
