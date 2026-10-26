import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { z } from 'zod'

import { AuditAction } from '@platform/core/audit'
import { TenantHeaders } from '@platform/core/auth'
import { ErrorCodes, HttpStatusCodes, PlatformException, unauthorized } from '@platform/core/errors'
import type { AuthenticatedRequest } from '@platform/core/logger'

import { AccessDenialAuditor } from './access-denial-auditor'
import { isTenantExempt } from './decorators'
import { TenantContextService } from './tenant-context.service'

// Global, after the AuthGuard. The store of a request is the one in X-Store-Id and nowhere else: a
// storeId in the body or the query is never read, here or in a service. The user must be an active
// member of that store, and what comes out is the context of the request: store, organization,
// membership and permissions.
//
// A store that does not exist and one the user does not belong to answer the same, so the response
// cannot be used to find out which stores exist.
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenants: TenantContextService,
    private readonly denials: AccessDenialAuditor
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (isTenantExempt(this.reflector, context)) return true
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    const user = request.user
    // The AuthGuard runs first and puts the user there. Without one, fail closed.
    if (user === undefined) {
      throw unauthorized('no authenticated user')
    }

    const header = request.header(TenantHeaders.STORE_ID)
    if (header === undefined || header.trim() === '') {
      throw new PlatformException(
        ErrorCodes.TENANT_HEADER_MISSING,
        'X-Store-Id header is required',
        HttpStatusCodes.BAD_REQUEST
      )
    }
    const parsed = z.uuid().safeParse(header)
    if (!parsed.success) {
      // Not echoed: it is whatever the caller sent
      throw new PlatformException(
        ErrorCodes.VALIDATION_FAILED,
        'X-Store-Id must be a UUID',
        HttpStatusCodes.BAD_REQUEST,
        { header: TenantHeaders.STORE_ID }
      )
    }
    const storeId = parsed.data.toLowerCase()

    const tenant = await this.tenants.resolve(user.id, storeId)
    if (tenant === null) {
      await this.denials.record({
        action: AuditAction.TENANT_ACCESS_DENIED,
        userId: user.id,
        request,
        metadata: { requestedStoreId: storeId }
      })
      throw new PlatformException(
        ErrorCodes.TENANT_ACCESS_DENIED,
        'No access to this store',
        HttpStatusCodes.FORBIDDEN
      )
    }

    // Copies that cannot be changed: a handler that edits what it was given must not alter what
    // another request of the same user in the same store is reading
    request.store = Object.freeze({ ...tenant.store })
    request.organization = Object.freeze({ id: tenant.store.organizationId })
    request.membership = Object.freeze({ ...tenant.membership })
    request.permissions = Object.freeze([...tenant.permissions])
    return true
  }
}
