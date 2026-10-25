import type { AuthenticatedUser } from '@platform/core/auth'
import type { AuthenticatedRequest } from '@platform/core/logger'

// Who did it, and from where: what the audit entry of every change records
export interface Actor {
  userId: string
  storeId: string
  ipAddress?: string | undefined
  userAgent?: string | undefined
}

export function actorOf(
  user: AuthenticatedUser,
  store: { id: string },
  request: AuthenticatedRequest
): Actor {
  return {
    userId: user.id,
    storeId: store.id,
    ipAddress: request.ip,
    userAgent: request.get('user-agent')
  }
}
