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
