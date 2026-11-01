import { ExportContentTypes } from '@platform/core/exports'
import {
  ExportFormats,
  ExportStatus,
  type ExportStatusType,
  type ExportType
} from '@platform/core/queues'

export interface ExportView {
  id: string
  type: ExportType
  format: string
  // A `ready` export past its date is reported as `expired` even before the cleanup marks the row
  status: ExportStatusType
  filename: string | null
  rowCount: number | null
  // An ErrorCode, never the text of an exception
  error: string | null
  createdAt: string
  completedAt: string | null
  expiresAt: string
}

export interface ExportDownload {
  url: string
  filename: string
  expiresInSeconds: number
}

// What an export row is read with: never the key of another store's file, never the filters
export const EXPORT_COLUMNS = {
  id: true,
  type: true,
  format: true,
  status: true,
  key: true,
  rowCount: true,
  error: true,
  createdAt: true,
  completedAt: true,
  expiresAt: true
} as const

export interface ExportRow {
  id: string
  type: string
  format: string
  status: string
  key: string | null
  rowCount: number | null
  error: string | null
  createdAt: Date
  completedAt: Date | null
  expiresAt: Date
}

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export function exportContentType(format: string): string {
  return format === ExportFormats.ZIP ? ExportContentTypes.ZIP : ExportContentTypes.CSV
}

export function exportView(row: ExportRow, now: Date = new Date()): ExportView {
  const expired = row.status === ExportStatus.READY && row.expiresAt <= now
  return {
    id: row.id,
    type: row.type as ExportType,
    format: row.format,
    status: expired ? ExportStatus.EXPIRED : (row.status as ExportStatusType),
    filename: row.key === null ? null : (row.key.split('/').at(-1) ?? null),
    rowCount: row.rowCount,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString()
  }
}
