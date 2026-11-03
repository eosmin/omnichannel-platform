import { Injectable } from '@nestjs/common'

import { TenantAccessStatuses } from '@platform/core/auth'
import { CacheKeys, CacheTTL } from '@platform/core/cache'
import { PrismaService } from '@platform/core/database'
import { isSuspended, MembershipStatus } from '@platform/core/domain'
import { CacheService } from '@platform/core/redis'

import {
  isPermission,
  type ResolvedTenant,
  type TenantAccess,
  tenantAccessSchema
} from './tenant-context'

const NAMESPACE = 'tenant-context'
// Two scopes per entry: the store (a role was edited, everybody in it) and the member (one user was
// added, removed or moved). A scope also protects a read that is loading when the change is made;
// deleting the key would not.
const storeScope = (storeId: string): string => `tenant:${storeId}`
const memberScope = (userId: string, storeId: string): string => `tenant:${storeId}:${userId}`

// What a user may do in a store. The answer is cached for CacheTTL.VERY_SHORT (30 s), so the cost of
// a request is a Redis read and not four joins. Two things keep it honest:
//
// - A change that must take effect at once drops the entry: invalidateUser for one member (removed,
//   role changed, invitation accepted) and invalidateStore for everybody in a store (a role was
//   edited). Whoever writes those changes calls them (Step 1.4).
// - A failure of Redis never grants anything: the context is read from the database.
@Injectable()
export class TenantContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService
  ) {}

  // null when the user has no active membership in the store (a suspended one included, so a caller
  // that only asks for a grant fails closed), for a store that does not exist as for one the user does
  // not belong to: the two cannot be told apart from outside.
  async resolve(userId: string, storeId: string): Promise<ResolvedTenant | null> {
    const access = await this.access(userId, storeId)
    return access.status === TenantAccessStatuses.GRANTED ? access.tenant : null
  }

  // The same answer, with a suspended member told apart from a stranger: what the guard of the
  // requests and the sockets use to say why. The cached entry holds one or the other, never both.
  async access(userId: string, storeId: string): Promise<TenantAccess> {
    const found = await this.cache.getOrSet({
      namespace: NAMESPACE,
      key: CacheKeys.agent.permissions(userId, storeId),
      ttlSeconds: CacheTTL.VERY_SHORT,
      schema: tenantAccessSchema,
      scopes: [storeScope(storeId), memberScope(userId, storeId)],
      load: () => this.load(userId, storeId)
    })
    if (found === null) return { status: TenantAccessStatuses.NONE }
    return 'suspended' in found
      ? { status: TenantAccessStatuses.SUSPENDED }
      : { status: TenantAccessStatuses.GRANTED, tenant: found }
  }

  invalidateUser(userId: string, storeId: string): Promise<void> {
    return this.cache.invalidateScope(memberScope(userId, storeId))
  }

  invalidateStore(storeId: string): Promise<void> {
    return this.cache.invalidateScope(storeScope(storeId))
  }

  private async load(
    userId: string,
    storeId: string
  ): Promise<ResolvedTenant | { suspended: true } | null> {
    const membership = await this.prisma.client.membership.findFirst({
      where: {
        userId,
        storeId,
        status: { in: [MembershipStatus.ACTIVE, MembershipStatus.SUSPENDED] },
        revokedAt: null
      },
      include: { store: true, role: { include: { permissions: true } } }
    })
    if (membership === null) return null
    // Nothing of the role is read into the answer: a suspended member has no permissions to cache
    if (isSuspended(membership.status)) return { suspended: true }
    return {
      store: {
        id: membership.store.id,
        organizationId: membership.store.organizationId,
        name: membership.store.name
      },
      membership: {
        id: membership.id,
        roleId: membership.role.id,
        roleName: membership.role.name
      },
      // A permission name the code does not know (a role from a newer or older version) grants nothing
      permissions: membership.role.permissions
        .map(permission => permission.name)
        .filter(isPermission)
    }
  }
}
