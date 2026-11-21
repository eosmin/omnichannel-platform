// What an audit entry is shown with. The row keeps ids and counts only (the code never writes a name, an address or a text of a
// customer into it), and the view adds nothing to that: the store and the organization stay out, they are the caller's own.
export interface AuditLogEntryView {
  id: string
  action: string
  // Null for the actions of the system and of a plugin (its installation is in the metadata)
  userId: string | null
  resourceType: string | null
  resourceId: string | null
  metadata: unknown
  ipAddress: string | null
  userAgent: string | null
  timestamp: string
}

export const AUDIT_LOG_COLUMNS = {
  id: true,
  action: true,
  userId: true,
  resourceType: true,
  resourceId: true,
  metadata: true,
  ipAddress: true,
  userAgent: true,
  timestamp: true
} as const

export interface AuditLogRow {
  id: string
  action: string
  userId: string | null
  resourceType: string | null
  resourceId: string | null
  metadata: unknown
  ipAddress: string | null
  userAgent: string | null
  timestamp: Date
}

export function auditLogEntryView(row: AuditLogRow): AuditLogEntryView {
  return {
    id: row.id,
    action: row.action,
    userId: row.userId,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    metadata: row.metadata,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    timestamp: row.timestamp.toISOString()
  }
}
