import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { type Permission } from '@platform/core/auth'
import { isUniqueViolation, PrismaService, type PrismaTransaction } from '@platform/core/database'
import { ErrorCodes, PlatformException } from '@platform/core/errors'

import { type Actor, isPermission, missingPermissions, TenantContextService } from '../tenancy'

import type { CreateRoleBody, UpdateRoleBody } from './team.schemas'

const HTTP_FORBIDDEN = 403
const HTTP_NOT_FOUND = 404
const HTTP_CONFLICT = 409

export interface RoleView {
  id: string
  name: string
  description: string | null
  isSystem: boolean
  permissions: string[]
}

const ROLE_SELECT = {
  id: true,
  name: true,
  description: true,
  isSystem: true,
  permissions: { select: { name: true }, orderBy: { name: 'asc' } }
} as const

function view(row: {
  id: string
  name: string
  description: string | null
  isSystem: boolean
  permissions: { name: string }[]
}): RoleView {
  return { ...row, permissions: row.permissions.map(permission => permission.name) }
}

// The roles a store can give: the system ones, and the custom ones of this store. A role of another
// store is one that does not exist.
@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tenants: TenantContextService
  ) {}

  async list(storeId: string): Promise<RoleView[]> {
    const rows = await this.prisma.client.role.findMany({
      where: { OR: [{ storeId }, { isSystem: true, storeId: null }] },
      select: ROLE_SELECT,
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }]
    })
    return rows.map(view)
  }

  async create(
    storeId: string,
    body: CreateRoleBody,
    actor: Actor,
    held: readonly Permission[]
  ): Promise<RoleView> {
    this.requireHolding(held, body.permissions)
    const role = await this.namedTransaction(async tx => {
      await this.requireFreeName(tx, storeId, body.name)
      return tx.role.create({
        data: {
          storeId,
          name: body.name,
          description: body.description ?? null,
          isSystem: false,
          permissions: { create: body.permissions.map(name => ({ name })) }
        },
        select: ROLE_SELECT
      })
    })
    this.log(AuditAction.ROLE_CREATED, storeId, role.id, actor, { name: role.name })
    return view(role)
  }

  async update(
    storeId: string,
    roleId: string,
    body: UpdateRoleBody,
    actor: Actor,
    held: readonly Permission[]
  ): Promise<RoleView> {
    const { before, after } = await this.namedTransaction(async tx => {
      const current = await this.findCustom(tx, storeId, roleId)
      const currentNames = current.permissions.map(permission => permission.name)
      // The role is as powerful as it is now and as it will be: the caller must hold both
      this.requireHolding(held, currentNames)
      if (body.permissions !== undefined) this.requireHolding(held, body.permissions)
      if (body.name !== undefined && body.name.toLowerCase() !== current.name.toLowerCase()) {
        await this.requireFreeName(tx, storeId, body.name)
      }
      if (body.permissions !== undefined) {
        await tx.permission.deleteMany({ where: { roleId } })
        await tx.permission.createMany({
          data: body.permissions.map(name => ({ roleId, name }))
        })
      }
      const updated = await tx.role.update({
        where: { id: roleId },
        data: {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.description === undefined ? {} : { description: body.description })
        },
        select: ROLE_SELECT
      })
      return { before: currentNames, after: updated }
    })
    // Everybody who holds the role has a new set of permissions, whatever the cache says
    await this.tenants.invalidateStore(storeId)
    const names = after.permissions.map(permission => permission.name)
    this.log(AuditAction.ROLE_UPDATED, storeId, roleId, actor, {
      name: after.name,
      added: names.filter(name => !before.includes(name)),
      removed: before.filter(name => !names.includes(name))
    })
    return view(after)
  }

  async remove(storeId: string, roleId: string, actor: Actor): Promise<void> {
    const role = await this.prisma.transaction(async tx => {
      const found = await this.findCustom(tx, storeId, roleId)
      const [members, invitations] = await Promise.all([
        tx.membership.count({ where: { roleId } }),
        tx.invitation.count({ where: { roleId } })
      ])
      if (members + invitations > 0) {
        throw new PlatformException(
          ErrorCodes.RESOURCE_CONFLICT,
          'a role that members or invitations hold cannot be deleted',
          HTTP_CONFLICT,
          { members, invitations }
        )
      }
      await tx.role.delete({ where: { id: roleId } })
      return found
    })
    this.log(AuditAction.ROLE_DELETED, storeId, roleId, actor, { name: role.name })
  }

  // A system role is the same for every store and is not edited from one of them
  private async findCustom(tx: PrismaTransaction, storeId: string, roleId: string) {
    const role = await tx.role.findFirst({
      where: { id: roleId, OR: [{ storeId }, { isSystem: true, storeId: null }] },
      select: ROLE_SELECT
    })
    if (role === null) throw notFound('role')
    if (role.isSystem) {
      throw new PlatformException(
        ErrorCodes.RESOURCE_CONFLICT,
        'a system role cannot be changed or deleted',
        HTTP_CONFLICT
      )
    }
    return role
  }

  // Case-insensitive, against the system roles too: two roles called "admin" and "Admin" in one
  // list is a mistake waiting for the person who picks one
  private async requireFreeName(
    tx: PrismaTransaction,
    storeId: string,
    name: string
  ): Promise<void> {
    const taken = await tx.role.findFirst({
      where: {
        name: { equals: name, mode: 'insensitive' },
        OR: [{ storeId }, { isSystem: true, storeId: null }]
      },
      select: { id: true }
    })
    if (taken !== null) throw nameTaken()
  }

  // The check above answers politely; the unique index of the table is what holds when two requests
  // ask for the same name at the same moment
  private async namedTransaction<T>(work: (tx: PrismaTransaction) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.transaction(work)
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken()
      throw error
    }
  }

  private requireHolding(held: readonly Permission[], needed: readonly string[]): void {
    const missing = missingPermissions(held, needed.filter(isPermission))
    if (missing.length > 0) {
      throw new PlatformException(
        ErrorCodes.PERMISSION_DENIED,
        'a role cannot hold permissions the caller lacks',
        HTTP_FORBIDDEN,
        { permissions: missing }
      )
    }
  }

  private log(
    action:
      | typeof AuditAction.ROLE_CREATED
      | typeof AuditAction.ROLE_UPDATED
      | typeof AuditAction.ROLE_DELETED,
    storeId: string,
    roleId: string,
    actor: Actor,
    metadata: Record<string, unknown>
  ): void {
    this.audit.log({
      action,
      actor: { userId: actor.userId },
      storeId,
      resourceType: 'role',
      resourceId: roleId,
      metadata,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
  }
}

function notFound(what: string): PlatformException {
  return new PlatformException(ErrorCodes.RESOURCE_NOT_FOUND, `${what} not found`, HTTP_NOT_FOUND)
}

function nameTaken(): PlatformException {
  return new PlatformException(
    ErrorCodes.RESOURCE_ALREADY_EXISTS,
    'a role with that name already exists',
    HTTP_CONFLICT
  )
}
