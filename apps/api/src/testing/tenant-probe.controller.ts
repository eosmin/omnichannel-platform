import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { Audit } from '@platform/core/audit-module'
import { Permissions } from '@platform/core/auth'
import { Public } from '@platform/core/auth-module'
import { PrismaService } from '@platform/core/database'
import { ErrorCodes, PlatformException } from '@platform/core/errors'
import type { AuthenticatedRequest } from '@platform/core/logger'

import {
  CurrentMembership,
  CurrentOrganization,
  CurrentStore,
  RequirePermissions,
  SkipTenant
} from '../modules/tenancy'

// ONLY FOR TESTS (never imported by the app): routes that stand for what the real controllers of
// the next steps will be, so that the guards are proved on a real request. The real resources replace
// them as they arrive (Step 1.4 onwards) and this file goes away.
@Controller('probe')
export class TenantProbeController {
  constructor(private readonly prisma: PrismaService) {}

  @RequirePermissions(Permissions.CUSTOMERS_VIEW)
  @Get('context')
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
  @Post('write')
  write(
    @CurrentStore() store: { id: string },
    @Body() body: Record<string, unknown>,
    @Query() query: Record<string, unknown>
  ): unknown {
    return { storeId: store.id, body, query }
  }

  // A tenant-scoped read the way a service does it (TDD_01 section 3.2, layer 2)
  @RequirePermissions(Permissions.CUSTOMERS_VIEW)
  @Get('tags')
  tags(@CurrentStore() store: { id: string }): Promise<{ id: string }[]> {
    return this.prisma.client.tag.findMany({ where: { storeId: store.id }, select: { id: true } })
  }

  @RequirePermissions(Permissions.CUSTOMERS_VIEW)
  @Get('tags/:id')
  async tag(@CurrentStore() store: { id: string }, @Param('id') id: string): Promise<unknown> {
    const tag = await this.prisma.client.tag.findFirst({
      where: { id, storeId: store.id },
      select: { id: true, storeId: true }
    })
    if (tag === null) {
      throw new PlatformException(ErrorCodes.RESOURCE_NOT_FOUND, 'tag not found', 404)
    }
    return tag
  }

  @RequirePermissions(Permissions.CUSTOMERS_VIEW)
  @Audit(AuditAction.CUSTOMER_VIEWED, { resourceType: 'probe' })
  @Get('audited/:id')
  audited(@Param('id') id: string): { id: string } {
    return { id }
  }

  // A route in a store that forgot to say what it needs: the guard must refuse it
  @Get('undeclared')
  undeclared(): { reached: true } {
    return { reached: true }
  }

  @SkipTenant()
  @Get('person')
  person(): { reached: true } {
    return { reached: true }
  }

  @Public()
  @Get('open')
  open(): { reached: true } {
    return { reached: true }
  }
}
