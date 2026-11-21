// The audit log viewer and its export (TDD_05 §9.3). The bounds of the filters are the ones the writer cuts the columns at
// (`AuditService`: resource type 64, resource id 255), so an entry the writer kept can always be asked for by its exact value.
export const AuditLogLimits = {
  ACTION_MAX_LENGTH: 100,
  RESOURCE_TYPE_MAX_LENGTH: 64,
  RESOURCE_ID_MAX_LENGTH: 255
} as const

// The `resourceType` of the entries the viewer itself writes
export const AuditLogResourceTypes = { AUDIT_LOG: 'audit_log' } as const
