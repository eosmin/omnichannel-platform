import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  type NestInterceptor,
  Optional
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { from, lastValueFrom, type Observable } from 'rxjs'

import { PrismaService, RLS_CONTEXT_ENABLED, type TenantContext } from '@platform/core/database'
import type { AuthenticatedRequest } from '@platform/core/logger'

import { NO_TENANT_TRANSACTION_KEY } from './decorators'

// Nest's own key of an @Sse() handler
const SSE_METADATA = '__sse__'

// What the guards resolved, as the context of the database: the store and the organization of a request of a store, the person of
// a request of a person (an account route has no store), nothing for a request nobody is behind (the public ones). The ids come
// from the guards, never from the body or the query. Exported for the specs.
export function tenantContextOf(request: AuthenticatedRequest): TenantContext | undefined {
  const userId = request.user?.id
  if (request.store !== undefined) {
    return {
      storeIds: [request.store.id],
      organizationIds: [request.store.organizationId],
      userId
    }
  }
  if (userId !== undefined) return { storeIds: [], organizationIds: [], userId }
  return undefined
}

// Global, after the guards: with RLS_CONTEXT on, the handler of a request runs inside ONE transaction that opens with the tenant
// context (TDD_01 §3.2, layer 3), so every query of the request, in any service, is filtered by the database as well as by the code.
// With it off, or on a route marked @NoTenantTransaction, or one that is not HTTP, or one with nobody behind it, it does nothing and
// the request behaves exactly as before; @Sse routes are skipped. The handler runs to its end inside the transaction, with the 15 s
// limit of PrismaService.tenantTransaction. What that costs, and the routes to mark before the switch is turned on (a route that
// writes and then throws, one that catches a unique violation and goes on, one with an @Res() or a call outside the database, one
// that reads the replica), is the inventory of the activation step (phase 6): the switch is off until it is done.
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    // Optional: an app that does not import the platform module (a test app) has no switch, and no switch is off
    @Optional() @Inject(RLS_CONTEXT_ENABLED) private readonly enabled?: boolean
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (this.enabled !== true || context.getType() !== 'http') return next.handle()
    // A server-sent stream emits many times over the life of the connection: it cannot be one transaction
    if (Reflect.getMetadata(SSE_METADATA, context.getHandler()) === true) return next.handle()
    const excluded = this.reflector.getAllAndOverride<string | undefined>(
      NO_TENANT_TRANSACTION_KEY,
      [context.getHandler(), context.getClass()]
    )
    if (excluded !== undefined) return next.handle()
    const tenant = tenantContextOf(context.switchToHttp().getRequest<AuthenticatedRequest>())
    if (tenant === undefined) return next.handle()
    return from(
      this.prisma.tenantTransaction(tenant, () =>
        lastValueFrom(next.handle(), { defaultValue: undefined })
      )
    )
  }
}
