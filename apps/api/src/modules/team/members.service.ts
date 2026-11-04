import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { AssigneePermissions, type Permission, RoleNames } from '@platform/core/auth'
import { lockStoreForWrite, PrismaService, type PrismaTransaction } from '@platform/core/database'
import { ConversationStatus, isSuspended, MembershipStatus } from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  resourceConflict,
  resourceNotFound,
  PlatformException
} from '@platform/core/errors'

import { RealtimeService } from '../realtime/realtime.service'
import { type Actor, isPermission, missingPermissions, TenantContextService } from '../tenancy'

export interface MemberView {
  id: string
  userId: string
  name: string
  email: string
  role: { id: string; name: string }
  // SUSPENDED: still on the team with the same role, but without access until reactivated
  status: MemberStatus
  joinedAt: Date
}

export type MemberStatus = MembershipStatus.ACTIVE | MembershipStatus.SUSPENDED

// What any agent of the store may know of a teammate: enough to name them, never how to reach them
export interface MemberDirectoryEntry {
  id: string
  name: string
  avatarMediaId: string | null
  role: { id: string; name: string }
  // Whether their role holds what a conversation needs to be given to someone (`AssigneePermissions`),
  // the rule the assignment applies; the inbox offers only these as an assignee. A yes or no, not the
  // permissions themselves.
  canBeAssigned: boolean
}

const ACTIVE = { status: MembershipStatus.ACTIVE, revokedAt: null } as const
// On the team: the ones who may enter and the ones who may not for now. The directory, which is who
// can be given work, keeps to ACTIVE.
const ON_THE_TEAM = {
  status: { in: [MembershipStatus.ACTIVE, MembershipStatus.SUSPENDED] as string[] },
  revokedAt: null
}

const MEMBER_SELECT = {
  id: true,
  userId: true,
  status: true,
  createdAt: true,
  user: { select: { name: true, email: true } },
  role: {
    select: { id: true, name: true, isSystem: true, permissions: { select: { name: true } } }
  }
} as const

function view(row: {
  id: string
  userId: string
  status: string
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
    status: isSuspended(row.status) ? MembershipStatus.SUSPENDED : MembershipStatus.ACTIVE,
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
    private readonly tenants: TenantContextService,
    private readonly realtime: RealtimeService
  ) {}

  async list(storeId: string): Promise<MemberView[]> {
    const rows = await this.prisma.client.membership.findMany({
      where: { storeId, ...ON_THE_TEAM },
      select: MEMBER_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
    })
    return rows.map(view)
  }

  async directory(storeId: string): Promise<MemberDirectoryEntry[]> {
    const rows = await this.prisma.client.membership.findMany({
      where: { storeId, ...ACTIVE },
      select: {
        userId: true,
        user: { select: { name: true, avatarMediaId: true } },
        role: {
          select: {
            id: true,
            name: true,
            permissions: {
              where: { name: { in: [...AssigneePermissions] } },
              select: { name: true }
            }
          }
        }
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
    })
    return rows.map(row => ({
      id: row.userId,
      name: row.user.name,
      avatarMediaId: row.user.avatarMediaId,
      role: { id: row.role.id, name: row.role.name },
      canBeAssigned: row.role.permissions.length === AssigneePermissions.length
    }))
  }

  async changeRole(
    storeId: string,
    membershipId: string,
    roleId: string,
    actor: Actor,
    held: readonly Permission[]
  ): Promise<MemberView> {
    const result = await this.prisma.transaction(async tx => {
      // The same lock as suspending: a role is not changed under a suspension that commits meanwhile
      await lockStoreForWrite(tx, storeId)
      const member = await this.findMember(tx, storeId, membershipId)
      // The role a suspended member comes back with is the one they had: it is not changed meanwhile
      if (isSuspended(member.status)) {
        throw resourceConflict('the role of a suspended member changes after it is reactivated')
      }
      const role = await tx.role.findFirst({
        where: { id: roleId, OR: [{ storeId }, { isSystem: true, storeId: null }] },
        select: { id: true, name: true, isSystem: true, permissions: { select: { name: true } } }
      })
      if (role === null) throw resourceNotFound('role')
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
      await lockStoreForWrite(tx, storeId)
      const found = await this.findMember(tx, storeId, membershipId)
      this.requireHolding(
        held,
        found.role.permissions.map(p => p.name)
      )
      if (isAdminRole(found.role)) await this.requireAnotherAdmin(tx, storeId, membershipId)
      await tx.membership.update({
        where: { id: membershipId },
        data: { status: MembershipStatus.REVOKED, revokedAt: new Date() }
      })
      // Whoever leaves the team leaves their conversations unassigned: nobody is waiting for an
      // answer from someone who can no longer give it
      await tx.conversation.updateMany({
        where: { storeId, assignedTo: found.userId },
        data: { assignedTo: null }
      })
      return found
    })
    await this.tenants.invalidateUser(member.userId, storeId)
    this.realtime.closeStoreUser(storeId, member.userId, ErrorCodes.TENANT_ACCESS_DENIED)
    this.log(AuditAction.MEMBER_REMOVED, storeId, membershipId, actor, {
      userId: member.userId,
      role: member.role.name
    })
  }

  // Takes a member out of the access of the store and out of the queue: the person keeps the
  // membership, the role and the history (a revoked one is gone for good, this one comes back). Only
  // an active member, by someone who holds what their role holds, never oneself, never the last
  // Admin that can enter.
  async suspend(
    storeId: string,
    membershipId: string,
    actor: Actor,
    held: readonly Permission[]
  ): Promise<MemberView> {
    const member = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      const found = await this.findMember(tx, storeId, membershipId)
      if (isSuspended(found.status)) {
        throw resourceConflict('the member is already suspended')
      }
      if (found.userId === actor.userId) {
        throw new PlatformException(
          ErrorCodes.PERMISSION_DENIED,
          'nobody suspends themselves',
          HttpStatusCodes.FORBIDDEN
        )
      }
      this.requireHolding(
        held,
        found.role.permissions.map(p => p.name)
      )
      if (isAdminRole(found.role)) await this.requireAnotherAdmin(tx, storeId, membershipId)
      await tx.membership.update({
        where: { id: membershipId },
        data: { status: MembershipStatus.SUSPENDED }
      })
      // Their conversations that are still being worked go back to the queue with their history:
      // nobody is waiting for an answer from someone who cannot give it, and the others may pick
      // them up. The finished ones (resolved, archived, spam) keep who handled them: the person
      // comes back, and the record of the work does not change.
      await tx.conversation.updateMany({
        where: {
          storeId,
          assignedTo: found.userId,
          status: {
            in: [ConversationStatus.OPEN, ConversationStatus.PENDING, ConversationStatus.SNOOZED]
          }
        },
        data: { assignedTo: null }
      })
      return found
    })
    // After the commit, so that nothing re-caches the old answer from a row that is still active
    await this.tenants.invalidateUser(member.userId, storeId)
    this.realtime.closeStoreUser(storeId, member.userId, ErrorCodes.TENANT_MEMBER_SUSPENDED)
    this.log(AuditAction.MEMBER_SUSPENDED, storeId, membershipId, actor, {
      userId: member.userId,
      role: member.role.name
    })
    return view({ ...member, status: MembershipStatus.SUSPENDED })
  }

  // Gives the access back with the role the member had. Held to the same rule as suspending: nobody
  // brings back a person whose role holds what they lack.
  async reactivate(
    storeId: string,
    membershipId: string,
    actor: Actor,
    held: readonly Permission[]
  ): Promise<MemberView> {
    const member = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      const found = await this.findMember(tx, storeId, membershipId)
      if (!isSuspended(found.status)) {
        throw resourceConflict('the member is not suspended')
      }
      this.requireHolding(
        held,
        found.role.permissions.map(p => p.name)
      )
      await tx.membership.update({
        where: { id: membershipId },
        data: { status: MembershipStatus.ACTIVE }
      })
      return found
    })
    await this.tenants.invalidateUser(member.userId, storeId)
    this.log(AuditAction.MEMBER_REACTIVATED, storeId, membershipId, actor, {
      userId: member.userId,
      role: member.role.name
    })
    return view({ ...member, status: MembershipStatus.ACTIVE })
  }

  // A member of the team of the store, active or suspended; a revoked one is not found
  private async findMember(tx: PrismaTransaction, storeId: string, membershipId: string) {
    const member = await tx.membership.findFirst({
      where: { id: membershipId, storeId, ...ON_THE_TEAM },
      select: MEMBER_SELECT
    })
    if (member === null) throw resourceNotFound('member')
    return member
  }

  private requireHolding(held: readonly Permission[], needed: readonly string[]): void {
    const missing = missingPermissions(held, needed.filter(isPermission))
    if (missing.length > 0) {
      throw new PlatformException(
        ErrorCodes.PERMISSION_DENIED,
        'a member cannot be given or taken a role that holds permissions the caller lacks',
        HttpStatusCodes.FORBIDDEN,
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
        HttpStatusCodes.CONFLICT
      )
    }
  }

  private log(
    action:
      | typeof AuditAction.ROLE_CHANGED
      | typeof AuditAction.MEMBER_REMOVED
      | typeof AuditAction.MEMBER_SUSPENDED
      | typeof AuditAction.MEMBER_REACTIVATED,
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
