// What the context of a user says about a store they ask for: a grant, a membership that is
// suspended (told apart so that the person is told why), or nothing
export const TenantAccessStatuses = {
  GRANTED: 'granted',
  SUSPENDED: 'suspended',
  NONE: 'none'
} as const

export type TenantAccessStatus = (typeof TenantAccessStatuses)[keyof typeof TenantAccessStatuses]

// Why an access was denied, as the audit entry of the denial records it
export const AccessDenialReasons = {
  SUSPENDED: 'suspended'
} as const
