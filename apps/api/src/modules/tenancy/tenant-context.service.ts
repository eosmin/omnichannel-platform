import { Injectable } from '@nestjs/common'

import { CacheKeys, CacheTTL } from '@platform/core/cache'
import { PrismaService } from '@platform/core/database'
import { MembershipStatus } from '@platform/core/domain'
import { CacheService } from '@platform/core/redis'

import { isPermission, type ResolvedTenant, resolvedTenantSchema } from './tenant-context'

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

  // null when the user has no active membership in the store, for a store that does not exist as
  // for one the user does not belong to: the two cannot be told apart from outside.
  resolve(userId: string, storeId: string): Promise<ResolvedTenant | null> {
    return this.cache.getOrSet({
      namespace: NAMESPACE,
      key: CacheKeys.agent.permissions(userId, storeId),
      ttlSeconds: CacheTTL.VERY_SHORT,
      schema: resolvedTenantSchema,
      scopes: [storeScope(storeId), memberScope(userId, storeId)],
      load: () => this.load(userId, storeId)
    })
  }

  invalidateUser(userId: string, storeId: string): Promise<void> {
    return this.cache.invalidateScope(memberScope(userId, storeId))
  }

  invalidateStore(storeId: string): Promise<void> {
    return this.cache.invalidateScope(storeScope(storeId))
  }

  private async load(userId: string, storeId: string): Promise<ResolvedTenant | null> {
    const membership = await this.prisma.client.membership.findFirst({
      where: { userId, storeId, status: MembershipStatus.ACTIVE, revokedAt: null },
      include: { store: true, role: { include: { permissions: true } } }
    })
    if (membership === null) return null
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
