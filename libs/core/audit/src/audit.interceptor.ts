import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { PinoLogger } from 'nestjs-pino'
import { type Observable, tap } from 'rxjs'

import type { AuthenticatedRequest } from '@platform/core/logger'

import { AUDIT_KEY, type AuditMetadata } from './audit.decorator'
import { AuditService } from './audit.service'

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(AuditInterceptor.name)
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.get<AuditMetadata | undefined>(AUDIT_KEY, context.getHandler())
    if (meta === undefined) return next.handle()
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    return next.handle().pipe(tap(() => this.record(meta, request)))
  }

  private record(meta: AuditMetadata, request: AuthenticatedRequest): void {
    const user = request.user
    if (user === undefined) {
      // @Audit on a route that nobody is logged in to: there is no actor to record, and guessing one
      // would make the trail lie. It is a mistake of the code, so say so.
      this.logger.error({ action: meta.action }, '@Audit on a handler with no authenticated user')
      return
    }
    const param = request.params[meta.resourceIdParam ?? 'id']
    this.audit.log({
      action: meta.action,
      actor: { userId: user.id },
      ...(request.store === undefined ? {} : { storeId: request.store.id }),
      ...(request.organization === undefined ? {} : { organizationId: request.organization.id }),
      resourceType: meta.resourceType,
      ...(typeof param === 'string' ? { resourceId: param } : {}),
      ...(request.ip === undefined ? {} : { ipAddress: request.ip }),
      ...(request.get('user-agent') === undefined ? {} : { userAgent: request.get('user-agent') })
    })
  }
}
