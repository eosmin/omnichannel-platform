import { providerStatusCodeOf, type ShipmentStatus } from '@platform/core/domain'

// What a connection's mapping table holds, by normalized code. A `null` status is the owner's choice to ignore a code on
// purpose (TDD_17 §4.17).
export type StatusMappingTable = ReadonlyMap<string, ShipmentStatus | null>

// What the plugin read from one event of the carrier: the code and the reason as the carrier sent them, and the status the
// plugin itself assumes for them (`null` when it cannot map the code)
export interface ResolvableEvent {
  rawStatus: string
  rawReason?: string
  status: ShipmentStatus | null
}

export const StatusResolutionKinds = {
  MAPPED: 'mapped', // a status the platform applies
  IGNORED: 'ignored', // the owner chose to give the code no effect: stored in the history, not counted as unknown
  UNMAPPED: 'unmapped' // no mapping and no default: the owner has to decide
} as const

export const StatusResolutionSources = {
  CONNECTION: 'connection', // a row of the mapping table of the connection
  PLUGIN: 'plugin' // the status the plugin gave the event
} as const

export type StatusResolution =
  | {
      kind: typeof StatusResolutionKinds.MAPPED
      status: ShipmentStatus
      source: (typeof StatusResolutionSources)[keyof typeof StatusResolutionSources]
      code: string
    }
  | { kind: typeof StatusResolutionKinds.IGNORED; code: string }
  | { kind: typeof StatusResolutionKinds.UNMAPPED; code: string }

// The meaning of an event for one connection (TDD_17 §4.17), in the order the text gives:
//  1. a row for the composite code `status:reason`, when the carrier sent a reason (the owner maps one reason alone);
//  2. a row for the plain status;
//  3. the status the plugin gave the event;
//  4. otherwise the code is unmapped.
// A row wins over the plugin even when it says "ignore". The code of an unmapped event is the composite one when there is
// a reason, because that is what the owner can map without touching the other reasons of the same status. Pure: it reads
// nothing and writes nothing.
export function resolveProviderStatus(
  event: ResolvableEvent,
  mappings: StatusMappingTable
): StatusResolution {
  const plain = providerStatusCodeOf(event.rawStatus)
  const code = providerStatusCodeOf(event.rawStatus, event.rawReason)
  for (const candidate of code === plain ? [plain] : [code, plain]) {
    if (!mappings.has(candidate)) continue
    const status = mappings.get(candidate) ?? null
    return status === null
      ? { kind: StatusResolutionKinds.IGNORED, code: candidate }
      : {
          kind: StatusResolutionKinds.MAPPED,
          status,
          source: StatusResolutionSources.CONNECTION,
          code: candidate
        }
  }
  if (event.status !== null) {
    return {
      kind: StatusResolutionKinds.MAPPED,
      status: event.status,
      source: StatusResolutionSources.PLUGIN,
      code
    }
  }
  return { kind: StatusResolutionKinds.UNMAPPED, code }
}
