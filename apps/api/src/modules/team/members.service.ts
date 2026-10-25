import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { type Permission, RoleNames } from '@platform/core/auth'
import { PrismaService, type PrismaTransaction } from '@platform/core/database'
import { MembershipStatus } from '@platform/core/domain'
import { ErrorCodes, PlatformException } from '@platform/core/errors'

import { type Actor, isPermission, missingPermissions, TenantContextService } from '../tenancy'

const HTTP_FORBIDDEN = 403
const HTTP_NOT_FOUND = 404
const HTTP_CONFLICT = 409

export interface MemberView {
  id: string
  userId: string
  name: string
  email: string
  role: { id: string; name: string }
  joinedAt: Date
}

const ACTIVE = { status: MembershipStatus.ACTIVE, revokedAt: null } as const

const MEMBER_SELECT = {
  id: true,
  userId: true,
  createdAt: true,
  user: { select: { name: true, email: true } },
  role: {
    select: { id: true, name: true, isSystem: true, permissions: { select: { name: true } } }
  }
} as const

function view(row: {
  id: string
  userId: string
  createdAt: Date
  user: { name: string; email: string }
  role: { id: string; name: string }
}): MemberView {
  return {
    id: row.id,
    userId: row.userId,
    name: row.user.name,
    email: row.user.email,
    role: { id: row.role.id, name: row.role.name },
    joinedAt: row.createdAt
  }
}

// The members of the store of the request. Every query is filtered by that store (TenantGuard), so a
// membership of another store is one that does not exist.
@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tenants: TenantContextService
  ) {}

  async list(storeId: string): Promise<MemberView[]> {
    const rows = await this.prisma.client.membership.findMany({
      where: { storeId, ...ACTIVE },
      select: MEMBER_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
    })
    return rows.map(view)
  }

  async changeRole(
    storeId: string,
    membershipId: string,
    roleId: string,
    actor: Actor,
    held: readonly Permission[]
  ): Promise<MemberView> {
    const result = await this.prisma.transaction(async tx => {
      const member = await this.findActive(tx, storeId, membershipId)
      const role = await tx.role.findFirst({
        where: { id: roleId, OR: [{ storeId }, { isSystem: true, storeId: null }] },
        select: { id: true, name: true, isSystem: true, permissions: { select: { name: true } } }
      })
      if (role === null) throw notFound('role')
      if (role.id === member.role.id) return { changed: false as const, member }

      // Neither the role the member has nor the one they get may hold what the caller lacks
      this.requireHolding(
        held,
        member.role.permissions.map(p => p.name)
      )
      this.requireHolding(
        held,
        role.permissions.map(p => p.name)
      )
      if (isAdminRole(member.role)) await this.requireAnotherAdmin(tx, storeId, membershipId)

      await tx.membership.update({ where: { id: membershipId }, data: { roleId } })
      return {
        changed: true as const,
        member: { ...member, role: { ...role, permissions: role.permissions } },
        from: member.role
      }
    })
    if (result.changed) {
      await this.tenants.invalidateUser(result.member.userId, storeId)
      this.log(AuditAction.ROLE_CHANGED, storeId, membershipId, actor, {
        userId: result.member.userId,
        from: { id: result.from.id, name: result.from.name },
        to: { id: result.member.role.id, name: result.member.role.name }
      })
    }
    return view(result.member)
  }

  // The membership is revoked, not deleted: the history of who belonged to the store stays, and the
  // guards already read only the active ones
  async remove(
    storeId: string,
    membershipId: string,
    actor: Actor,
    held: readonly Permission[]
  ): Promise<void> {
    const member = await this.prisma.transaction(async tx => {
      const found = await this.findActive(tx, storeId, membershipId)
      this.requireHolding(
        held,
        found.role.permissions.map(p => p.name)
      )
      if (isAdminRole(found.role)) await this.requireAnotherAdmin(tx, storeId, membershipId)
      await tx.membership.update({
        where: { id: membershipId },
        data: { status: MembershipStatus.REVOKED, revokedAt: new Date() }
      })
      return found
    })
    await this.tenants.invalidateUser(member.userId, storeId)
    this.log(AuditAction.MEMBER_REMOVED, storeId, membershipId, actor, {
      userId: member.userId,
      role: member.role.name
    })
  }

  private async findActive(tx: PrismaTransaction, storeId: string, membershipId: string) {
    const member = await tx.membership.findFirst({
      where: { id: membershipId, storeId, ...ACTIVE },
      select: MEMBER_SELECT
    })
    if (member === null) throw notFound('member')
    return member
  }

  private requireHolding(held: readonly Permission[], needed: readonly string[]): void {
    const missing = missingPermissions(held, needed.filter(isPermission))
    if (missing.length > 0) {
      throw new PlatformException(
        ErrorCodes.PERMISSION_DENIED,
        'a member cannot be given or taken a role that holds permissions the caller lacks',
        HTTP_FORBIDDEN,
        { permissions: missing }
      )
    }
  }

  // A store keeps at least one Admin. The Admins are locked while this is decided: two Admins who
  // lower each other at the same moment would otherwise each see the other still there.
  private async requireAnotherAdmin(
    tx: PrismaTransaction,
    storeId: string,
    leavingMembershipId: string
  ): Promise<void> {
    const admins = await tx.$queryRaw<{ id: string }[]>`
      SELECT m.id FROM memberships m JOIN roles r ON r.id = m.role_id
      WHERE m.store_id = ${storeId} AND m.status = ${MembershipStatus.ACTIVE}
        AND m.revoked_at IS NULL AND r.is_system AND r.name = ${RoleNames.ADMIN}
      FOR UPDATE OF m`
    if (!admins.some(admin => admin.id !== leavingMembershipId)) {
      throw new PlatformException(
        ErrorCodes.TENANT_CANNOT_REMOVE_LAST_ADMIN,
        'a store keeps at least one Admin',
        HTTP_CONFLICT
      )
    }
  }

  private log(
    action: typeof AuditAction.ROLE_CHANGED | typeof AuditAction.MEMBER_REMOVED,
    storeId: string,
    membershipId: string,
    actor: Actor,
    metadata: Record<string, unknown>
  ): void {
    this.audit.log({
      action,
      actor: { userId: actor.userId },
      storeId,
      resourceType: 'membership',
      resourceId: membershipId,
      metadata,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
  }
}

// The system Admin: a custom role that happens to be called Admin is not the one a store must keep
function isAdminRole(role: { name: string; isSystem: boolean }): boolean {
  return role.isSystem && role.name === RoleNames.ADMIN
}

function notFound(what: string): PlatformException {
  return new PlatformException(ErrorCodes.RESOURCE_NOT_FOUND, `${what} not found`, HTTP_NOT_FOUND)
}
