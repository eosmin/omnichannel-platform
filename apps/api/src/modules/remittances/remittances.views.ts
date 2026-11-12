import type { CodStatus, RemittanceLineOutcome, RemittanceStatus } from '@platform/core/domain'

// What the api says of a remittance of cash collected on delivery (TDD_17 §4.15, §6). It carries amounts and guide numbers
// only: never the recipient, the address or the phone of the order (REMITTANCES_VIEW is not a permission to read customers).

export const REMITTANCE_SELECT = {
  id: true,
  connectionId: true,
  status: true,
  reference: true,
  receivedOn: true,
  importProfileId: true,
  sourceMediaId: true,
  expectedCents: true,
  reportedCents: true,
  feeCents: true,
  note: true,
  createdBy: true,
  createdAt: true,
  confirmedAt: true,
  confirmedBy: true,
  voidedAt: true,
  voidedBy: true,
  connection: { select: { displayName: true, carrierId: true } },
  _count: { select: { lines: true } }
} as const

export interface RemittanceRow {
  id: string
  connectionId: string
  status: string
  reference: string | null
  receivedOn: Date | null
  importProfileId: string | null
  sourceMediaId: string | null
  expectedCents: number
  reportedCents: number
  feeCents: number
  note: string | null
  createdBy: string
  createdAt: Date
  confirmedAt: Date | null
  confirmedBy: string | null
  voidedAt: Date | null
  voidedBy: string | null
  connection: { displayName: string; carrierId: string }
  _count: { lines: number }
}

export interface RemittanceTotalsView {
  expectedCents: number
  reportedCents: number
  feeCents: number
  // reported minus expected
  differenceCents: number
}

export interface RemittanceView {
  id: string
  connectionId: string
  connectionName: string
  carrierId: string
  status: RemittanceStatus
  reference: string | null
  receivedOn: string | null
  importProfileId: string | null
  hasSourceFile: boolean
  // For a draft the totals are worked out now from its lines; a confirmed remittance keeps the ones written when it was confirmed
  totals: RemittanceTotalsView
  lineCount: number
  note: string | null
  createdBy: string
  createdAt: string
  confirmedAt: string | null
  confirmedBy: string | null
  voidedAt: string | null
  voidedBy: string | null
}

export interface RemittanceLineView {
  id: string
  position: number
  guideNumber: string
  shipmentId: string | null
  orderNumber: string | null
  reportedCents: number
  reportedFeeCents: number | null
  expectedCents: number | null
  // reported minus expected, when the line is held against a shipment
  differenceCents: number | null
  outcome: RemittanceLineOutcome
  excluded: boolean
  note: string | null
}

export interface RemittanceDetailView extends RemittanceView {
  lines: RemittanceLineView[]
}

export function remittanceViewOf(row: RemittanceRow, totals: RemittanceTotalsView): RemittanceView {
  return {
    id: row.id,
    connectionId: row.connectionId,
    connectionName: row.connection.displayName,
    carrierId: row.connection.carrierId,
    status: row.status as RemittanceStatus,
    reference: row.reference,
    receivedOn: row.receivedOn?.toISOString().slice(0, 10) ?? null,
    importProfileId: row.importProfileId,
    hasSourceFile: row.sourceMediaId !== null,
    totals,
    lineCount: row._count.lines,
    note: row.note,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    confirmedBy: row.confirmedBy,
    voidedAt: row.voidedAt?.toISOString() ?? null,
    voidedBy: row.voidedBy
  }
}

// One shipment that still owes cash, with how long it has waited
export interface PendingShipmentView {
  shipmentId: string
  orderNumber: string
  guideNumber: string | null
  codStatus: CodStatus
  expectedCents: number
  remittedCents: number | null
  // What is still owed for it: expected minus what a remittance already brought (negative when the carrier sent more)
  owedCents: number
  deliveredAt: string | null
  ageDays: number | null
}

export interface PendingConnectionView {
  connectionId: string
  connectionName: string
  carrierId: string
  count: number
  // The sum of what is still owed on every shipment of the connection that waits for a remittance
  totalOwedCents: number
  oldestDeliveredAt: string | null
  oldestAgeDays: number | null
  // Filled only when one connection is asked for, oldest first and bounded
  shipments: PendingShipmentView[]
  truncated: boolean
}
