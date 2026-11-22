// The audit entries of a store that the filters of the viewer and of the export find. Both read the rows with this one rule, so
// the file holds the rows the screen shows. The store comes from the request context and is the first term, always: an entry
// with no store (the actions of a person, of the system and of the guards) belongs to no tenant and is never found here.
export interface AuditLogFilters {
  // The exact name of an action (`AuditAction`), not a prefix: a prefix would make the index of `action` a scan
  action?: string
  userId?: string
  resourceType?: string
  resourceId?: string
  // Inclusive start and exclusive end of the range of `timestamp`
  from?: Date
  before?: Date
}

export interface AuditLogWhere {
  storeId: string
  action?: string
  userId?: string
  resourceType?: string
  resourceId?: string
  timestamp?: { gte?: Date; lt?: Date }
}

export function auditLogWhere(storeId: string, filters: AuditLogFilters): AuditLogWhere {
  return {
    storeId,
    ...(filters.action === undefined ? {} : { action: filters.action }),
    ...(filters.userId === undefined ? {} : { userId: filters.userId }),
    ...(filters.resourceType === undefined ? {} : { resourceType: filters.resourceType }),
    ...(filters.resourceId === undefined ? {} : { resourceId: filters.resourceId }),
    ...(filters.from === undefined && filters.before === undefined
      ? {}
      : {
          timestamp: {
            ...(filters.from === undefined ? {} : { gte: filters.from }),
            ...(filters.before === undefined ? {} : { lt: filters.before })
          }
        })
  }
}

// What `auditLogMatches` reads of an entry
export interface AuditLogMatchable {
  storeId: string | null
  action: string
  userId: string | null
  resourceType: string | null
  resourceId: string | null
  timestamp: Date
}

// The same rule as `auditLogWhere`, for an entry that is not in the database (a line of the cold archive): the store first and
// always (an entry with no store matches nobody), then each filter exactly, and the range as inclusive start and exclusive end.
// The two are kept together so that the screen shows the same rows from the database and from the archive.
export function auditLogMatches(
  storeId: string,
  filters: AuditLogFilters,
  entry: AuditLogMatchable
): boolean {
  if (entry.storeId !== storeId) return false
  if (filters.action !== undefined && entry.action !== filters.action) return false
  if (filters.userId !== undefined && entry.userId !== filters.userId) return false
  if (filters.resourceType !== undefined && entry.resourceType !== filters.resourceType) {
    return false
  }
  if (filters.resourceId !== undefined && entry.resourceId !== filters.resourceId) return false
  const at = entry.timestamp.getTime()
  if (filters.from !== undefined && at < filters.from.getTime()) return false
  if (filters.before !== undefined && at >= filters.before.getTime()) return false
  return true
}
