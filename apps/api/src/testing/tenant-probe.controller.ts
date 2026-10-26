import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { Audit } from '@platform/core/audit-module'
import { Permissions } from '@platform/core/auth'
import { Public } from '@platform/core/auth-module'
import type { AuthenticatedRequest } from '@platform/core/logger'

import {
  CurrentMembership,
  CurrentOrganization,
  CurrentStore,
  RequirePermissions,
  SkipTenant
} from '../modules/tenancy'

// The paths of the probe, used by the controller and by the suites that call it
export const ProbeRoutes = {
  context: '/probe/context',
  write: '/probe/write',
  audited: (id: string) => `/probe/audited/${id}`,
  undeclared: '/probe/undeclared',
  person: '/probe/person',
  open: '/probe/open'
} as const

// ONLY FOR TESTS (never imported by the app): routes that prove the guards on a real request, for
// what no real resource can show (a route with no declared permission, a route of a person, an
// audited route). It is registered by tests/helpers/app.ts and by auth-test-app.ts. The tenant
// resources are proved on their real routes in tests/security/tenant-isolation.spec.ts, and the routes
// that leak on purpose live in tests/helpers/leaky-tag.controller.ts, not here.
@Controller()
export class TenantProbeController {
  @RequirePermissions(Permissions.CUSTOMERS_VIEW)
  @Get(ProbeRoutes.context)
  context(
    @CurrentStore() store: { id: string; organizationId: string },
    @CurrentOrganization() organization: { id: string },
    @CurrentMembership() membership: { id: string; roleName: string },
    @Req() request: AuthenticatedRequest
  ): unknown {
    return {
      storeId: store.id,
      organizationId: organization.id,
      membership,
      permissions: request.permissions
    }
  }

  // The store comes from the guard. Whatever the body or the query say about it is carried back
  // untouched, to show that nothing used it.
  @RequirePermissions(Permissions.CUSTOMERS_EDIT)
  @Post(ProbeRoutes.write)
  write(
    @CurrentStore() store: { id: string },
    @Body() body: Record<string, unknown>,
    @Query() query: Record<string, unknown>
  ): unknown {
    return { storeId: store.id, body, query }
  }

  @RequirePermissions(Permissions.CUSTOMERS_VIEW)
  @Audit(AuditAction.CUSTOMER_VIEWED, { resourceType: 'probe' })
  @Get(ProbeRoutes.audited(':id'))
  audited(@Param('id') id: string): { id: string } {
    return { id }
  }

  // A route in a store that forgot to say what it needs: the guard must refuse it
  @Get(ProbeRoutes.undeclared)
  undeclared(): { reached: true } {
    return { reached: true }
  }

  @SkipTenant()
  @Get(ProbeRoutes.person)
  person(): { reached: true } {
    return { reached: true }
  }

  @Public()
  @Get(ProbeRoutes.open)
  open(): { reached: true } {
    return { reached: true }
  }
}
