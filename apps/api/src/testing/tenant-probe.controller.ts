import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common'

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

// The paths of the probe, used by the controller and by the suites that call it
export const ProbeRoutes = {
  context: '/probe/context',
  write: '/probe/write',
  tags: '/probe/tags',
  tagById: (id: string) => `/probe/tags/${id}`,
  leakyTagById: (id: string) => `/probe/leaky/tags/${id}`,
  lateCheckTagById: (id: string) => `/probe/late-check/tags/${id}`,
  audited: (id: string) => `/probe/audited/${id}`,
  undeclared: '/probe/undeclared',
  person: '/probe/person',
  open: '/probe/open'
} as const

// ONLY FOR TESTS (never imported by the app): routes that stand for what the real controllers of
// the next steps will be, so that the guards are proved on a real request. The real resources replace
// them as they arrive (Step 1.4 onwards) and this file goes away.
@Controller()
export class TenantProbeController {
  constructor(private readonly prisma: PrismaService) {}

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

  // A tenant-scoped read the way a service does it (TDD_01 section 3.2, layer 2)
  @RequirePermissions(Permissions.CUSTOMERS_VIEW)
  @Get(ProbeRoutes.tags)
  tags(@CurrentStore() store: { id: string }): Promise<{ id: string }[]> {
    return this.prisma.client.tag.findMany({ where: { storeId: store.id }, select: { id: true } })
  }

  @RequirePermissions(Permissions.CUSTOMERS_VIEW)
  @Get(ProbeRoutes.tagById(':id'))
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

  // A tag is written into the store of the request, whatever the body says about its store
  @RequirePermissions(Permissions.CUSTOMERS_EDIT)
  @Post(ProbeRoutes.tags)
  async createTag(
    @CurrentStore() store: { id: string },
    @Body() body: Record<string, unknown>
  ): Promise<{ id: string; storeId: string }> {
    return this.prisma.client.tag.create({
      data: { storeId: store.id, name: nameOf(body), color: '#8b5cf6' },
      select: { id: true, storeId: true }
    })
  }

  @RequirePermissions(Permissions.CUSTOMERS_EDIT)
  @Patch(ProbeRoutes.tagById(':id'))
  async renameTag(
    @CurrentStore() store: { id: string },
    @Param('id') id: string,
    @Body() body: Record<string, unknown>
  ): Promise<{ id: string }> {
    const changed = await this.prisma.client.tag.updateMany({
      where: { id, storeId: store.id },
      data: { name: nameOf(body) }
    })
    if (changed.count === 0) {
      throw new PlatformException(ErrorCodes.RESOURCE_NOT_FOUND, 'tag not found', 404)
    }
    return { id }
  }

  // ON PURPOSE WRONG: the two routes below forget the store, as a service that was written without
  // thinking about tenants would. They exist so that the suite can be shown to fail on a leak (see
  // tests/security/isolation-detects-leaks.spec.ts): a suite that never failed would prove nothing.
  @RequirePermissions(Permissions.CUSTOMERS_VIEW)
  @Get(ProbeRoutes.leakyTagById(':id'))
  async leakyTag(@Param('id') id: string): Promise<unknown> {
    const tag = await this.prisma.client.tag.findUnique({
      where: { id },
      select: { id: true, storeId: true }
    })
    if (tag === null) {
      throw new PlatformException(ErrorCodes.RESOURCE_NOT_FOUND, 'tag not found', 404)
    }
    return tag
  }

  @RequirePermissions(Permissions.CUSTOMERS_EDIT)
  @Patch(ProbeRoutes.leakyTagById(':id'))
  async leakyRenameTag(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>
  ): Promise<{ id: string }> {
    await this.prisma.client.tag.update({ where: { id }, data: { name: nameOf(body) } })
    return { id }
  }

  // ALSO ON PURPOSE WRONG, and harder to see: it changes the row first and checks the store
  // afterwards, so the answer is the right one (404) and the damage is done. Only a check that looks
  // at the row catches it.
  @RequirePermissions(Permissions.CUSTOMERS_EDIT)
  @Patch(ProbeRoutes.lateCheckTagById(':id'))
  async lateCheckRenameTag(
    @CurrentStore() store: { id: string },
    @Param('id') id: string,
    @Body() body: Record<string, unknown>
  ): Promise<{ id: string }> {
    const tag = await this.prisma.client.tag.update({
      where: { id },
      data: { name: nameOf(body) },
      select: { storeId: true }
    })
    if (tag.storeId !== store.id) {
      throw new PlatformException(ErrorCodes.RESOURCE_NOT_FOUND, 'tag not found', 404)
    }
    return { id }
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

function nameOf(body: Record<string, unknown>): string {
  return typeof body['name'] === 'string' ? body['name'].slice(0, 64) : 'unnamed'
}
