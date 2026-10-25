import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Counter } from '@prometheus-io/client'
import { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import type { Permission } from '@platform/core/auth'
import { ErrorCodes, PlatformException } from '@platform/core/errors'
import type { AuthenticatedRequest } from '@platform/core/logger'
import { MetricNames } from '@platform/core/metrics'
import { InjectMetric } from '@platform/core/metrics-module'

import { AccessDenialAuditor } from './access-denial-auditor'
import { isTenantExempt, PERMISSIONS_KEY, routePathOf } from './decorators'

const FORBIDDEN = 403
const INTERNAL = 500

// Global, after the TenantGuard. A route in a store has to say what it needs with
// @RequirePermissions(...): one that says nothing is refused, so a handler added without thinking
// about permissions is closed and not open. (A test lists every route and fails on such a handler
// before it gets here.)
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly denials: AccessDenialAuditor,
    private readonly logger: PinoLogger,
    @InjectMetric(MetricNames.PERMISSION_DENIALS) private readonly denied: Counter<string>
  ) {
    this.logger.setContext(PermissionGuard.name)
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (isTenantExempt(this.reflector, context)) return true
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    const granted = request.permissions
    // TenantGuard sets them. If it did not run, nothing can be decided: refuse.
    if (granted === undefined || request.user === undefined) {
      throw new PlatformException(
        ErrorCodes.INTERNAL_ERROR,
        'PermissionGuard ran before TenantGuard',
        INTERNAL
      )
    }

    const required = this.reflector.getAllAndMerge<Permission[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass()
    ])
    if (required.length === 0) {
      this.logger.error(
        { path: routePathOf(request), method: request.method },
        'a route in a store declares no @RequirePermissions: refused'
      )
      throw new PlatformException(
        ErrorCodes.PERMISSION_DENIED,
        'this route declares no permission',
        FORBIDDEN
      )
    }

    const missing = required.filter(permission => !granted.includes(permission))
    if (missing.length === 0) return true

    for (const permission of missing) this.denied.inc({ permission })
    await this.denials.record({
      action: AuditAction.PERMISSION_DENIED,
      userId: request.user.id,
      request,
      ...(request.store === undefined ? {} : { storeId: request.store.id }),
      metadata: { missing }
    })
    throw new PlatformException(ErrorCodes.PERMISSION_DENIED, 'Missing permission', FORBIDDEN, {
      required: missing
    })
  }
}
