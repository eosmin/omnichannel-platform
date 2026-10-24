import type { Request } from 'express'

import type { Permission } from '@platform/core/auth'

// What the guards and middleware write on the request. They write to this type, never to `any`.
// Staff, impersonation and access levels do not exist in the MVP (MVP_TRIM_CHECKLIST.md).
export interface AuthenticatedRequest extends Request {
  correlationId: string
  user?: { id: string }
  store?: { id: string }
  organization?: { id: string }
  membership?: { id: string }
  permissions?: readonly Permission[]
}
