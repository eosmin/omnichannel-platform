import { Inject, Injectable } from '@nestjs/common'
import type { Redis } from 'ioredis'
import { PinoLogger } from 'nestjs-pino'

import { AuditAction, type AuditActionType } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { CacheKeys } from '@platform/core/cache'
import type { AuthenticatedRequest } from '@platform/core/logger'
import { REDIS_CLIENT } from '@platform/core/redis'

import { routePathOf } from './decorators'

// A user who is refused keeps being refused: a script that probes stores or permissions would write
// a row per request. The metrics count every refusal; the audit log keeps this many per user and
// kind a minute, which is enough to see the pattern and cannot fill the table.
const DENIALS_AUDITED_PER_MINUTE = 10
const WINDOW_SECONDS = 60

export type DenialAction =
  typeof AuditAction.TENANT_ACCESS_DENIED | typeof AuditAction.PERMISSION_DENIED

export interface Denial {
  action: DenialAction
  userId: string
  request: AuthenticatedRequest
  // The store the user is a member of, when there is one. A store the user asked for and does not
  // belong to goes in the metadata, never in the store column: it is a value the caller chose.
  storeId?: string
  metadata: Record<string, unknown>
}

@Injectable()
export class AccessDenialAuditor {
  constructor(
    private readonly audit: AuditService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(AccessDenialAuditor.name)
  }

  // Never throws: the refusal that follows must not turn into a 500
  async record(denial: Denial): Promise<void> {
    if (!(await this.withinBudget(denial.userId, denial.action))) return
    const { request } = denial
    this.audit.log({
      action: denial.action,
      actor: { userId: denial.userId },
      ...(denial.storeId === undefined ? {} : { storeId: denial.storeId }),
      ...(request.organization === undefined ? {} : { organizationId: request.organization.id }),
      metadata: {
        method: request.method,
        path: routePathOf(request),
        ...denial.metadata
      },
      ...(request.ip === undefined ? {} : { ipAddress: request.ip }),
      ...(request.get('user-agent') === undefined ? {} : { userAgent: request.get('user-agent') })
    })
  }

  private async withinBudget(userId: string, action: AuditActionType): Promise<boolean> {
    const key = CacheKeys.audit.denialBudget(userId, action)
    try {
      // One step: count and, if the counter has no end yet, give the minute its end. Two commands
      // would leave a counter that never expires if the process died between them, and the refusals
      // of that user would never be audited again. NX keeps the minute from sliding on every refusal.
      const results = await this.redis.multi().incr(key).expire(key, WINDOW_SECONDS, 'NX').exec()
      const counted = results?.[0]
      if (counted === undefined || counted[0] !== null || typeof counted[1] !== 'number')
        return true
      const count = counted[1]
      if (count === DENIALS_AUDITED_PER_MINUTE + 1) {
        this.logger.warn(
          { userId, action },
          'refusals of one user are no longer written to the audit log this minute'
        )
      }
      return count <= DENIALS_AUDITED_PER_MINUTE
    } catch {
      return true // Without the budget a duplicate trace is better than none
    }
  }
}
