import { SetMetadata } from '@nestjs/common'

import type { AuditActionType } from '@platform/core/audit'

export const AUDIT_KEY = 'audit'

export interface AuditMetadata {
  action: AuditActionType
  resourceType: string
  // The route parameter that holds the id of the resource ("id" by default)
  resourceIdParam?: string
}

// @Audit(AuditAction.CUSTOMER_VIEWED, { resourceType: 'customer' }) on a handler: once it has
// answered successfully, the AuditInterceptor writes the entry. A handler that fails writes none.
export const Audit = (
  action: AuditActionType,
  options: { resourceType: string; resourceIdParam?: string }
): MethodDecorator => SetMetadata(AUDIT_KEY, { action, ...options } satisfies AuditMetadata)
