import type { ExportView } from '@platform/api-client'
import { ClientPermissions, type Permission } from '@platform/core/auth'
import {
  ExportStatus,
  ExportTypePermissions,
  type ExportStatusType,
  ExportTypes,
  type ExportType
} from '@platform/core/exports'

const KNOWN_TYPES: ReadonlySet<string> = new Set(Object.values(ExportTypes))
const KNOWN_STATUSES: ReadonlySet<string> = new Set(Object.values(ExportStatus))

export const UNKNOWN_EXPORT_LABEL = 'unknown'

// Typed as the keys of the messages, so a kind added without its text fails to compile
export type ExportTypeKey = ExportType | typeof UNKNOWN_EXPORT_LABEL
export type ExportStatusKey = ExportStatusType | typeof UNKNOWN_EXPORT_LABEL

// The message key of a kind or a state. A value this page does not know (a server newer than the
// page) draws under "unknown" instead of as an empty cell.
export function exportTypeKey(type: string): ExportTypeKey {
  return KNOWN_TYPES.has(type) ? (type as ExportType) : UNKNOWN_EXPORT_LABEL // Narrowed by the set
}

export function exportStatusKey(status: string): ExportStatusKey {
  return KNOWN_STATUSES.has(status) ? (status as ExportStatusType) : UNKNOWN_EXPORT_LABEL // Narrowed by the set
}

export function isExportReady(item: Pick<ExportView, 'status'>): boolean {
  return item.status === ExportStatus.READY
}

// One of these is enough to open the exports center (the api lists only what the member asked for,
// of the kinds the role may still make)
export const ExportPermissions: readonly Permission[] = [
  ClientPermissions.ANALYTICS_EXPORT,
  ClientPermissions.CONVERSATIONS_EXPORT,
  ClientPermissions.CUSTOMERS_EXPORT,
  ClientPermissions.MEDIA_DOWNLOAD_ALL,
  ClientPermissions.ORDERS_EXPORT
]

export function mayOpenExports(can: (permission: Permission) => boolean): boolean {
  return ExportPermissions.some(permission => can(permission))
}

// The kinds the center can be narrowed to: the ones this version makes. A row of any other kind still
// draws (under "Other") when no filter is on.
export const FILTERABLE_TYPES: readonly ExportType[] = [
  ExportTypes.CONVERSATIONS,
  ExportTypes.CUSTOMERS,
  ExportTypes.ORDERS,
  ExportTypes.ANALYTICS,
  ExportTypes.MEDIA_ZIP
]

// The kinds this member may see, as the api lists them (`ExportTypePermissions`: every permission of the kind). A
// filter that offered a kind the member can never see would answer with an empty list (N-BR2-17).
export function visibleExportTypes(can: (permission: Permission) => boolean): ExportType[] {
  return FILTERABLE_TYPES.filter(type => {
    const needed = ExportTypePermissions[type]
    // A kind with no entry is not served (the api shows nobody its rows): it is not offered either
    return needed !== undefined && needed.every(can)
  })
}

export const FILTERABLE_STATUSES: readonly ExportStatusType[] = [
  ExportStatus.PENDING,
  ExportStatus.READY,
  ExportStatus.FAILED,
  ExportStatus.EXPIRED
]

// The value of a select that names no kind or no state
export const ALL_EXPORTS = ''

// The kind a select holds, or null for "all" and for a value this page does not offer
export function exportTypeFilter(value: string): ExportType | null {
  return FILTERABLE_TYPES.find(type => type === value) ?? null
}

export function exportStatusFilter(value: string): ExportStatusType | null {
  return FILTERABLE_STATUSES.find(status => status === value) ?? null
}
