import type { PrismaService } from '@platform/core/database'
import { ShipmentKind, ShipmentStatus } from '@platform/core/domain'

// What a carrier calls the package an event is about. The plugin copies what the carrier sent: all three are the carrier's
// words, so each is bounded before it reaches a query.
export interface ShipmentNames {
  providerShipmentId?: string | undefined
  guideNumber?: string | undefined
  // The order number, when the carrier echoes it
  reference?: string | undefined
}

export const ShipmentLookupKinds = {
  FOUND: 'found',
  // Nothing of this connection answers to the names
  UNKNOWN: 'unknown',
  // The order number names more than one live package of the connection: guessing would move the wrong one
  AMBIGUOUS: 'ambiguous'
} as const

export type ShipmentLookup =
  | { kind: typeof ShipmentLookupKinds.FOUND; shipmentId: string }
  | { kind: typeof ShipmentLookupKinds.UNKNOWN | typeof ShipmentLookupKinds.AMBIGUOUS }

// A package that is over: a carrier event that names only the order cannot be about it
const OVER: readonly string[] = [
  ShipmentStatus.CANCELLED,
  ShipmentStatus.FAILED,
  ShipmentStatus.RETURNED,
  ShipmentStatus.DELIVERED
]

type Client = Pick<PrismaService['client'], 'shipment'>

// Finds the shipment of one connection that a carrier event names (TDD_17 §4.9), by the most exact name first: the carrier's
// own id, then the guide number, then the order number. Every read names the store and the connection, so a guide number that
// another store (or another carrier) also prints is never this one. The order number counts only when it points at ONE package
// that is not over; the carrier that echoes it is the one that never gave the core a guide number back (an unknown outcome).
export async function findShipmentOfEvent(
  client: Client,
  scope: { storeId: string; connectionId: string },
  names: ShipmentNames
): Promise<ShipmentLookup> {
  const base = { ...scope, kind: ShipmentKind.OUTBOUND }
  if (names.providerShipmentId !== undefined && names.providerShipmentId !== '') {
    const rows = await client.shipment.findMany({
      where: { ...base, providerShipmentId: names.providerShipmentId },
      select: { id: true },
      take: 2
    })
    if (rows.length === 1 && rows[0] !== undefined) return found(rows[0].id)
    if (rows.length > 1) return { kind: ShipmentLookupKinds.AMBIGUOUS }
  }
  if (names.guideNumber !== undefined && names.guideNumber !== '') {
    const rows = await client.shipment.findMany({
      where: { ...base, guideNumber: names.guideNumber },
      select: { id: true },
      take: 2
    })
    if (rows.length === 1 && rows[0] !== undefined) return found(rows[0].id)
    if (rows.length > 1) return { kind: ShipmentLookupKinds.AMBIGUOUS }
  }
  if (names.reference !== undefined && names.reference !== '') {
    const rows = await client.shipment.findMany({
      where: {
        ...base,
        status: { notIn: [...OVER] },
        order: { orderNumber: names.reference }
      },
      select: { id: true },
      take: 2
    })
    if (rows.length === 1 && rows[0] !== undefined) return found(rows[0].id)
    if (rows.length > 1) return { kind: ShipmentLookupKinds.AMBIGUOUS }
  }
  return { kind: ShipmentLookupKinds.UNKNOWN }
}

function found(shipmentId: string): ShipmentLookup {
  return { kind: ShipmentLookupKinds.FOUND, shipmentId }
}
