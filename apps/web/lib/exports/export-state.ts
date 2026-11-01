import type { ExportView } from '@platform/api-client'
import { Permissions, type Permission } from '@platform/core/auth'
import {
  ExportStatus,
  type ExportStatusType,
  ExportTypes,
  type ExportType
} from '@platform/core/exports'

// How often the list asks again while an export is being made. The realtime event and the
// notification of a ready export belong to Step 3.5; until then the page watches by itself.
export const EXPORT_POLL_MS = 5000

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

export function hasPendingExport(items: readonly Pick<ExportView, 'status'>[]): boolean {
  return items.some(item => item.status === ExportStatus.PENDING)
}

// One of these is enough to open the exports center (the api lists only what the member asked for,
// of the kinds the role may still make)
export const ExportPermissions: readonly Permission[] = [
  Permissions.CONVERSATIONS_EXPORT,
  Permissions.CUSTOMERS_EXPORT,
  Permissions.MEDIA_DOWNLOAD_ALL
]

export function mayOpenExports(can: (permission: Permission) => boolean): boolean {
  return ExportPermissions.some(permission => can(permission))
}
