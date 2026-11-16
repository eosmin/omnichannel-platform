import type { CursorPage } from '@platform/core/domain'

import type { RemittanceImportProfileView } from './remittance-profiles.service'
import type {
  PendingConnectionView,
  PendingShipmentView,
  RemittanceDetailView,
  RemittanceLineView,
  RemittanceView
} from './remittances.views'

// What a plugin reads of the remittances of cash collected on delivery (Step 5.6 PR E6). The fields are named one by one, so a column
// added to the views of the screen does not reach a plugin until someone decides it should. Left out on purpose:
// - `createdBy`, `confirmedBy`, `voidedBy`: the ids of the people of the team who made, confirmed and voided it (the team directory
//   has no scope);
// - `sourceMediaId`: the file the draft was imported from; no scope reads files of that purpose yet (PR E7 adds the media routes and
//   decides it), so an id that opens nothing is not handed out.
// The amounts, the guide numbers and the state of each line are what the scope is for; the lines carry no recipient, address or phone.
// The lists inside an answer (the lines, the pending shipments) are named one by one too, not passed through.

export type PluginRemittanceView = Omit<
  RemittanceView,
  'createdBy' | 'confirmedBy' | 'voidedBy' | 'sourceMediaId'
>
export type PluginRemittanceDetailView = Omit<
  RemittanceDetailView,
  'createdBy' | 'confirmedBy' | 'voidedBy' | 'sourceMediaId'
>
export type PluginRemittancePage = Omit<CursorPage<RemittanceView>, 'data'> & {
  data: PluginRemittanceView[]
}

export function pluginRemittanceView(view: RemittanceView): PluginRemittanceView {
  return {
    id: view.id,
    connectionId: view.connectionId,
    connectionName: view.connectionName,
    carrierId: view.carrierId,
    status: view.status,
    reference: view.reference,
    receivedOn: view.receivedOn,
    importProfileId: view.importProfileId,
    totals: view.totals,
    lineCount: view.lineCount,
    note: view.note,
    createdAt: view.createdAt,
    confirmedAt: view.confirmedAt,
    voidedAt: view.voidedAt,
    voidReason: view.voidReason
  }
}

export function pluginRemittanceLineView(line: RemittanceLineView): RemittanceLineView {
  return {
    id: line.id,
    position: line.position,
    guideNumber: line.guideNumber,
    shipmentId: line.shipmentId,
    orderNumber: line.orderNumber,
    reportedCents: line.reportedCents,
    reportedFeeCents: line.reportedFeeCents,
    expectedCents: line.expectedCents,
    differenceCents: line.differenceCents,
    outcome: line.outcome,
    excluded: line.excluded,
    note: line.note,
    warnings: line.warnings
  }
}

export function pluginRemittanceDetailView(view: RemittanceDetailView): PluginRemittanceDetailView {
  return { ...pluginRemittanceView(view), lines: view.lines.map(pluginRemittanceLineView) }
}

function pluginPendingShipmentView(shipment: PendingShipmentView): PendingShipmentView {
  return {
    shipmentId: shipment.shipmentId,
    orderNumber: shipment.orderNumber,
    guideNumber: shipment.guideNumber,
    codStatus: shipment.codStatus,
    expectedCents: shipment.expectedCents,
    remittedCents: shipment.remittedCents,
    owedCents: shipment.owedCents,
    deliveredAt: shipment.deliveredAt,
    ageDays: shipment.ageDays
  }
}

export function pluginPendingConnectionView(view: PendingConnectionView): PendingConnectionView {
  return {
    connectionId: view.connectionId,
    connectionName: view.connectionName,
    carrierId: view.carrierId,
    count: view.count,
    totalOwedCents: view.totalOwedCents,
    oldestDeliveredAt: view.oldestDeliveredAt,
    oldestAgeDays: view.oldestAgeDays,
    shipments: view.shipments.map(pluginPendingShipmentView),
    truncated: view.truncated
  }
}

export function pluginImportProfileView(
  profile: RemittanceImportProfileView
): RemittanceImportProfileView {
  return {
    id: profile.id,
    connectionId: profile.connectionId,
    name: profile.name,
    delimiter: profile.delimiter,
    hasHeader: profile.hasHeader,
    decimalSeparator: profile.decimalSeparator,
    dateFormat: profile.dateFormat,
    columns: { ...profile.columns },
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt
  }
}

export function pluginRemittancePage(page: CursorPage<RemittanceView>): PluginRemittancePage {
  return { ...page, data: page.data.map(pluginRemittanceView) }
}
