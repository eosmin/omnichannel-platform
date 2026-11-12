import type { PickupStatus, PickupWaitReason } from '@platform/core/domain'

export const PICKUP_SELECT = {
  id: true,
  connectionId: true,
  pickupDate: true,
  status: true,
  packageCount: true,
  revision: true,
  providerPickupId: true,
  windowStart: true,
  windowEnd: true,
  requestedBy: true,
  lastError: true,
  createdAt: true,
  updatedAt: true,
  connection: { select: { displayName: true, carrierId: true } }
} as const

export interface PickupRow {
  id: string
  connectionId: string
  pickupDate: Date
  status: string
  packageCount: number
  revision: number
  providerPickupId: string | null
  windowStart: string | null
  windowEnd: string | null
  requestedBy: string
  lastError: string | null
  createdAt: Date
  updatedAt: Date
  connection: { displayName: string; carrierId: string }
}

// What the api says of a pickup (TDD_17 §2, §6). `requestedBy` is a user id or 'system'; `lastError` is a name the screen
// translates, or the carrier's own line, bounded.
export interface PickupView {
  id: string
  connectionId: string
  connectionName: string
  carrierId: string
  // 'YYYY-MM-DD', in the timezone of the store
  pickupDate: string
  status: PickupStatus
  packageCount: number
  revision: number
  providerPickupId: string | null
  windowStart: string | null
  windowEnd: string | null
  requestedBy: string
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export function pickupViewOf(row: PickupRow): PickupView {
  return {
    id: row.id,
    connectionId: row.connectionId,
    connectionName: row.connection.displayName,
    carrierId: row.connection.carrierId,
    pickupDate: row.pickupDate.toISOString().slice(0, 10),
    status: row.status as PickupStatus,
    packageCount: row.packageCount,
    revision: row.revision,
    providerPickupId: row.providerPickupId,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    requestedBy: row.requestedBy,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  }
}

// The answer of a request: the pickup, and what became of each guide that was offered (the ones that wait, with the reason)
export interface PickupRequestView {
  pickup: PickupView
  created: boolean
  joined: string[]
  waiting: { shipmentId: string; reason: PickupWaitReason }[]
}
