import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { type Permission, Permissions, RoleNames } from '@platform/core/auth'
import {
  isUniqueViolation,
  lockStoreForDelete,
  PrismaService,
  type PrismaTransaction,
  slugify
} from '@platform/core/database'
import { MembershipStatus } from '@platform/core/domain'
import { ErrorCodes, PlatformException } from '@platform/core/errors'

import { type Actor, isPermission, missingPermissions, TenantContextService } from '../tenancy'

import type {
  CreateStoreBody,
  UpdateOrganizationBody,
  UpdateStoreBody
} from './organizations.schemas'

const HTTP_FORBIDDEN = 403
const HTTP_NOT_FOUND = 404
const HTTP_CONFLICT = 409

export interface OrganizationView {
  id: string
  name: string
  slug: string
}

export interface StoreView {
  id: string
  name: string
  slug: string
  timezone: string
  currency: string
  defaultLocale: string
  createdAt: Date
}

const STORE_FIELDS = {
  id: true,
  name: true,
  slug: true,
  timezone: true,
  currency: true,
  defaultLocale: true,
  createdAt: true
} as const

// Tables whose rows go with the store and are not data of the business: the rest of the tables that
// have a store_id hold what the store did, and a store that has any of it is not deleted
const TABLES_OF_THE_STORE_ITSELF = [
  'store_settings',
  'retention_settings',
  'business_hours',
  'memberships',
  'invitations',
  'roles',
  'audit_logs' // History: it has no foreign key to the store and outlives it
]

// The stores of the organization the caller manages: those where they are an active member and the
// role holds ORG_MANAGE_STORES. The permission comes with the store it was given in, so a store the
// caller does not belong to is one that does not exist for them, as a store of another organization.
const managedBy = (userId: string) => ({
  memberships: {
    some: {
      userId,
      status: MembershipStatus.ACTIVE,
      revokedAt: null,
      role: { permissions: { some: { name: Permissions.ORG_MANAGE_STORES } } }
    }
  }
})

// Every query here is filtered by the organization of the request (TenantGuard), never by one the
// caller names: a store of another organization is a store that does not exist.
@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tenants: TenantContextService
  ) {}

  async getOrganization(organizationId: string): Promise<OrganizationView> {
    const organization = await this.prisma.client.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, name: true, slug: true }
    })
    if (organization === null) throw notFound('organization')
    return organization
  }

  async updateOrganization(
    organizationId: string,
    body: UpdateOrganizationBody,
    actor: Actor
  ): Promise<OrganizationView> {
    const organization = await this.prisma.client.organization.update({
      where: { id: organizationId },
      data: { name: body.name },
      select: { id: true, name: true, slug: true }
    })
    this.audit.log({
      action: AuditAction.ORGANIZATION_UPDATED,
      actor: { userId: actor.userId },
      storeId: actor.storeId,
      organizationId,
      resourceType: 'organization',
      resourceId: organizationId,
      metadata: { fields: ['name'] },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return organization
  }

  listStores(organizationId: string, actor: Actor): Promise<StoreView[]> {
    return this.prisma.client.store.findMany({
      where: { organizationId, ...managedBy(actor.userId) },
      select: STORE_FIELDS,
      orderBy: [{ name: 'asc' }, { id: 'asc' }]
    })
  }

  async getStore(organizationId: string, storeId: string, actor: Actor): Promise<StoreView> {
    const store = await this.prisma.client.store.findFirst({
      where: { id: storeId, organizationId, ...managedBy(actor.userId) },
      select: STORE_FIELDS
    })
    if (store === null) throw notFound('store')
    return store
  }

  // The creator becomes an Admin of the new store, or they could not open it: the organization has
  // no member who is not a member of one of its stores. Nobody makes themselves what they are not,
  // so only someone who holds everything an Admin holds creates one.
  async createStore(
    organizationId: string,
    body: CreateStoreBody,
    actor: Actor,
    held: readonly Permission[]
  ): Promise<StoreView> {
    const admin = await this.prisma.client.role.findFirst({
      where: { isSystem: true, storeId: null, name: RoleNames.ADMIN },
      select: { id: true, permissions: { select: { name: true } } }
    })
    if (admin === null) {
      throw new PlatformException(ErrorCodes.INTERNAL_ERROR, 'the Admin role does not exist', 500)
    }
    const missing = missingPermissions(
      held,
      admin.permissions.map(permission => permission.name).filter(isPermission)
    )
    if (missing.length > 0) {
      throw new PlatformException(
        ErrorCodes.PERMISSION_DENIED,
        'a store is created only by someone who holds what its Admin holds',
        HTTP_FORBIDDEN,
        { permissions: missing }
      )
    }
    const store = await this.writing(() =>
      this.prisma.transaction(async tx => {
        const created = await tx.store.create({
          data: {
            organizationId,
            name: body.name,
            slug: slugify(body.name),
            ...definedOnly({
              timezone: body.timezone,
              currency: body.currency,
              defaultLocale: body.defaultLocale
            }),
            // A store always has both settings rows (TDD_01 §4)
            settings: { create: {} },
            retentionSettings: { create: {} }
          },
          select: STORE_FIELDS
        })
        await tx.membership.create({
          data: {
            userId: actor.userId,
            organizationId,
            storeId: created.id,
            roleId: admin.id,
            status: MembershipStatus.ACTIVE
          }
        })
        return created
      })
    )
    await this.tenants.invalidateUser(actor.userId, store.id)
    this.logStore(AuditAction.STORE_CREATED, organizationId, store.id, actor, {})
    return store
  }

  async updateStore(
    organizationId: string,
    storeId: string,
    body: UpdateStoreBody,
    actor: Actor
  ): Promise<StoreView> {
    const changes = definedOnly(body)
    const { count } = await this.prisma.client.store.updateMany({
      where: { id: storeId, organizationId, ...managedBy(actor.userId) },
      data: changes
    })
    if (count === 0) throw notFound('store')
    // The name of the store is part of what the guards cache
    await this.tenants.invalidateStore(storeId)
    this.logStore(AuditAction.STORE_UPDATED, organizationId, storeId, actor, {
      fields: Object.keys(changes)
    })
    return this.getStore(organizationId, storeId, actor)
  }

  // The last store of an organization stays: with none, nobody could sign in to it. A store that
  // holds data (conversations, customers, orders, whatever a later step adds) is not deleted: that
  // is the owner's decision to take with the data in hand, not a click.
  async deleteStore(organizationId: string, storeId: string, actor: Actor): Promise<void> {
    await this.prisma.transaction(async tx => {
      const target = await tx.store.findFirst({
        where: { id: storeId, organizationId, ...managedBy(actor.userId) },
        select: { id: true }
      })
      if (target === null) throw notFound('store')
      // Two deletes at once would each see the other store still there: the organization is locked
      // while its stores are counted
      await tx.$queryRaw`SELECT id FROM organizations WHERE id = ${organizationId} FOR UPDATE`
      if ((await tx.store.count({ where: { organizationId } })) === 1) {
        throw new PlatformException(
          ErrorCodes.RESOURCE_CONFLICT,
          'the last store of an organization cannot be deleted',
          HTTP_CONFLICT
        )
      }
      // Waits for the writes of data of the store that are in flight; the ones that come later find no
      // store. The tables are looked at only after this, so a row written before it is seen.
      await lockStoreForDelete(tx, storeId)
      const holding = await storesTablesWithRows(tx, storeId)
      if (holding.length > 0) {
        throw new PlatformException(
          ErrorCodes.RESOURCE_CONFLICT,
          'a store that holds data cannot be deleted',
          HTTP_CONFLICT,
          { tables: holding }
        )
      }
      await tx.store.deleteMany({ where: { id: storeId, organizationId } })
    })
    await this.tenants.invalidateStore(storeId)
    this.logStore(AuditAction.STORE_DELETED, organizationId, storeId, actor, {})
  }

  private logStore(
    action:
      | typeof AuditAction.STORE_CREATED
      | typeof AuditAction.STORE_UPDATED
      | typeof AuditAction.STORE_DELETED,
    organizationId: string,
    storeId: string,
    actor: Actor,
    metadata: Record<string, unknown>
  ): void {
    this.audit.log({
      action,
      actor: { userId: actor.userId },
      // The store that was acted on, not the one the request came through
      storeId,
      organizationId,
      resourceType: 'store',
      resourceId: storeId,
      metadata: { ...metadata, requestStoreId: actor.storeId },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
  }

  private async writing<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new PlatformException(
          ErrorCodes.RESOURCE_ALREADY_EXISTS,
          'a store with that name already exists',
          HTTP_CONFLICT
        )
      }
      throw error
    }
  }
}

function notFound(what: string): PlatformException {
  return new PlatformException(ErrorCodes.RESOURCE_NOT_FOUND, `${what} not found`, HTTP_NOT_FOUND)
}

// Prisma takes undefined for "leave it", but the audit entry lists what was really changed
function definedOnly<T extends Record<string, unknown>>(fields: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  ) as Partial<T> // Same keys, minus the undefined ones
}

// Every table with a store_id, found in the catalog so that a table added by a later step is counted
// without anyone remembering to list it. The identifiers come from the catalog and are quoted by
// format(%I); the store id is a literal (%L).
async function storesTablesWithRows(tx: PrismaTransaction, storeId: string): Promise<string[]> {
  const rows = await tx.$queryRaw<{ table_name: string; n: number }[]>`
    SELECT c.table_name,
      (xpath('/row/n/text()', query_to_xml(
        format('SELECT count(*) AS n FROM %I WHERE store_id = %L', c.table_name, ${storeId}::text),
        false, true, '')))[1]::text::int AS n
    FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.column_name = 'store_id'
      AND c.table_name <> ALL (${TABLES_OF_THE_STORE_ITSELF})`
  return rows.filter(row => row.n > 0).map(row => row.table_name)
}
