import { Injectable } from '@nestjs/common'

import type { Permission } from '@platform/core/auth'
import { PrismaService } from '@platform/core/database'
import { MembershipStatus } from '@platform/core/domain'
import { unauthorized } from '@platform/core/errors'

import { isPermission } from '../tenancy'

// A store of the user with what their role allows there. The server still decides every request;
// the browser reads this to hide what would be refused.
export interface AccountMembership {
  storeId: string
  storeName: string
  role: string
  permissions: Permission[]
}

export interface AccountProfile {
  id: string
  email: string
  name: string
  emailVerified: boolean
  locale: string
  timezone: string | null
  density: string
  memberships: AccountMembership[]
}

@Injectable()
export class AccountService {
  constructor(private readonly prisma: PrismaService) {}

  // The access token outlives the account for up to its lifetime, so the user may be gone
  async profile(userId: string): Promise<AccountProfile> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        emailVerified: true,
        locale: true,
        timezone: true,
        density: true,
        memberships: {
          where: { status: MembershipStatus.ACTIVE, revokedAt: null },
          orderBy: { store: { name: 'asc' } },
          select: {
            store: { select: { id: true, name: true } },
            role: { select: { name: true, permissions: { select: { name: true } } } }
          }
        }
      }
    })
    if (user === null) {
      throw unauthorized('account no longer exists')
    }
    const { memberships, ...profile } = user
    return {
      ...profile,
      memberships: memberships.map(membership => ({
        storeId: membership.store.id,
        storeName: membership.store.name,
        role: membership.role.name,
        // A permission name the code does not know grants nothing, as in TenantContextService
        permissions: membership.role.permissions
          .map(permission => permission.name)
          .filter(isPermission)
      }))
    }
  }
}
