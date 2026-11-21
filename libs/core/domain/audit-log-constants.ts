// The audit log viewer and its export (TDD_05 §9.3). The bounds are those of the filters a request may carry; an entry written by
// the code is always shorter than these.
export const AuditLogLimits = {
  ACTION_MAX_LENGTH: 100,
  RESOURCE_TYPE_MAX_LENGTH: 100,
  RESOURCE_ID_MAX_LENGTH: 200
} as const
