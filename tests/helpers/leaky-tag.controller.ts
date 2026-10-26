import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common'

import { Permissions } from '@platform/core/auth'
import { PrismaService } from '@platform/core/database'
import { resourceNotFound } from '@platform/core/errors'

import { CurrentStore, RequirePermissions } from '../../apps/api/src/modules/tenancy'

export const LeakyRoutes = {
  tags: '/leaky/tags',
  businessHours: '/leaky/business-hours',
  tagById: (id: string) => `/leaky/tags/${id}`,
  lateCheckTagById: (id: string) => `/leaky/late-check/tags/${id}`
} as const

// ON PURPOSE WRONG, and only for tests/security/isolation-detects-leaks.spec.ts: routes that read and
// change a tag the way a service written without thinking about tenants would. They exist so that
// the isolation suite can be shown to fail on a leak: a suite that never failed would prove nothing.
@Controller()
export class LeakyTagController {
  constructor(private readonly prisma: PrismaService) {}

  // Lists every tag of the platform
  @RequirePermissions(Permissions.CUSTOMERS_VIEW)
  @Get(LeakyRoutes.tags)
  list(): Promise<{ id: string }[]> {
    return this.prisma.client.tag.findMany({ select: { id: true } })
  }

  // Trusts the store the body names
  @RequirePermissions(Permissions.CUSTOMERS_EDIT)
  @Post(LeakyRoutes.tags)
  create(
    @CurrentStore() store: { id: string },
    @Body() body: Record<string, unknown>
  ): Promise<{ id: string }> {
    const storeId = typeof body['storeId'] === 'string' ? body['storeId'] : store.id
    return this.prisma.client.tag.create({
      data: { storeId, name: nameOf(body), color: '#8b5cf6' },
      select: { id: true }
    })
  }

  // The hours of whichever store comes first, not the one of the request
  @RequirePermissions(Permissions.CUSTOMERS_VIEW)
  @Get(LeakyRoutes.businessHours)
  async firstBusinessHours(): Promise<unknown> {
    const hours = await this.prisma.client.businessHours.findFirst({
      orderBy: { updatedAt: 'desc' },
      select: { timezone: true }
    })
    if (hours === null) throw resourceNotFound('business hours')
    return hours
  }

  // Forgets the store altogether
  @RequirePermissions(Permissions.CUSTOMERS_VIEW)
  @Get(LeakyRoutes.tagById(':id'))
  async tag(@Param('id') id: string): Promise<unknown> {
    const tag = await this.prisma.client.tag.findUnique({
      where: { id },
      select: { id: true, storeId: true }
    })
    if (tag === null) {
      throw resourceNotFound('tag')
    }
    return tag
  }

  @RequirePermissions(Permissions.CUSTOMERS_EDIT)
  @Patch(LeakyRoutes.tagById(':id'))
  async rename(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>
  ): Promise<{ id: string }> {
    await this.prisma.client.tag.update({ where: { id }, data: { name: nameOf(body) } })
    return { id }
  }

  // Harder to see: it changes the row first and checks the store afterwards, so the answer is the
  // right one (404) and the damage is done. Only a check that looks at the row catches it.
  @RequirePermissions(Permissions.CUSTOMERS_EDIT)
  @Patch(LeakyRoutes.lateCheckTagById(':id'))
  async lateCheckRename(
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
      throw resourceNotFound('tag')
    }
    return { id }
  }
}

function nameOf(body: Record<string, unknown>): string {
  return typeof body['name'] === 'string' ? body['name'].slice(0, 64) : 'unnamed'
}
