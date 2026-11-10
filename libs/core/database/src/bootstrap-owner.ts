import { RoleNames, RolePresets, type RoleName } from '@platform/core/auth'
import { DefaultWarehouse, FIRST_WAREHOUSE_PRIORITY, MembershipStatus } from '@platform/core/domain'

import type { PrismaClient } from '../generated/client/client'

export interface BootstrapInput {
  ownerEmail: string
  ownerName: string
  organizationName: string
  storeName: string
}

export interface BootstrapResult {
  organizationId: string
  storeId: string
  ownerId: string
}

// "Tienda Escalón" -> "tienda-escalon"
export function slugify(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (slug === '') throw new Error(`"${name}" has no letters or digits to build a slug from`)
  return slug
}

// System roles have no store, so their uniqueness comes from a partial index and not from a
// compound unique that an upsert could use. ON CONFLICT DO NOTHING (skipDuplicates) honours that
// index, so two concurrent runs cannot both insert the role.
async function ensureSystemRole(prisma: PrismaClient, name: RoleName): Promise<{ id: string }> {
  await prisma.role.createMany({ data: [{ name, isSystem: true }], skipDuplicates: true })
  const role = await prisma.role.findFirstOrThrow({ where: { storeId: null, name } })
  // Permissions are reconciled on every run, so a preset that gained a permission reaches the
  // role without a data migration. A permission removed from a preset is not revoked here.
  await prisma.permission.createMany({
    data: RolePresets[name].map(permission => ({ roleId: role.id, name: permission })),
    skipDuplicates: true
  })
  return role
}

export async function ensureStore(
  prisma: PrismaClient,
  organizationId: string,
  name: string
): Promise<{ id: string }> {
  const store = await prisma.store.upsert({
    where: { organizationId_slug: { organizationId, slug: slugify(name) } },
    create: { organizationId, name, slug: slugify(name) },
    update: {}
  })
  // A store always has both settings rows (Step 1.4 must too)
  await prisma.storeSettings.upsert({
    where: { storeId: store.id },
    create: { storeId: store.id },
    update: {}
  })
  await prisma.retentionSettings.upsert({
    where: { storeId: store.id },
    create: { storeId: store.id },
    update: {}
  })
  return store
}

// A warehouse of the organization, by its code: made once, whatever the number of runs
export async function ensureWarehouse(
  prisma: PrismaClient,
  organizationId: string,
  warehouse: { code: string; name: string }
): Promise<{ id: string }> {
  return prisma.warehouse.upsert({
    where: { organizationId_code: { organizationId, code: warehouse.code } },
    create: { organizationId, code: warehouse.code, name: warehouse.name },
    update: {},
    select: { id: true }
  })
}

// Links a store to a warehouse of its organization (the database refuses another organization's). A link that
// exists is left as it is, priority included; a new one takes the given priority, or the next free one of the store.
export async function ensureStoreWarehouse(
  prisma: PrismaClient,
  ids: { organizationId: string; storeId: string; warehouseId: string },
  priority?: number
): Promise<void> {
  const existing = await prisma.storeWarehouse.findUnique({
    where: { storeId_warehouseId: { storeId: ids.storeId, warehouseId: ids.warehouseId } },
    select: { id: true }
  })
  if (existing !== null) return
  const taken = await prisma.storeWarehouse.aggregate({
    where: { storeId: ids.storeId },
    _max: { priority: true }
  })
  await prisma.storeWarehouse.create({
    data: { ...ids, priority: priority ?? (taken._max.priority ?? 0) + 1 }
  })
}

// The warehouse every store needs to hold stock in. Idempotent and safe in production, and it never undoes what the
// owner did: the default warehouse is made only when the organization has NO warehouse at all (so a renamed, recoded
// or unlinked one does not come back as a twin), and the store is linked only when it has no link at all (so a
// store the owner reorganized keeps its priorities). The link goes to the oldest warehouse of the organization.
export async function ensureDefaultWarehouse(
  prisma: PrismaClient,
  organizationId: string,
  storeId: string
): Promise<{ id: string }> {
  const existing = await prisma.warehouse.findFirst({
    where: { organizationId },
    // An active warehouse first: a store is not linked to one the owner switched off
    orderBy: [{ active: 'desc' }, { createdAt: 'asc' }, { code: 'asc' }],
    select: { id: true }
  })
  const warehouse =
    existing ??
    (await ensureWarehouse(prisma, organizationId, {
      code: DefaultWarehouse.CODE,
      name: DefaultWarehouse.NAME
    }))
  const links = await prisma.storeWarehouse.count({ where: { storeId } })
  if (links === 0) {
    await ensureStoreWarehouse(
      prisma,
      { organizationId, storeId, warehouseId: warehouse.id },
      FIRST_WAREHOUSE_PRIORITY
    )
  }
  return warehouse
}

export async function ensureUser(
  prisma: PrismaClient,
  email: string,
  name: string
): Promise<{ id: string }> {
  // Users have no password: the account is verified by the magic link or by this bootstrap
  return prisma.user.upsert({
    where: { email },
    create: { email, name, emailVerified: true },
    update: {}
  })
}

export async function ensureMembership(
  prisma: PrismaClient,
  ids: { userId: string; organizationId: string; storeId: string; roleId: string }
): Promise<void> {
  await prisma.membership.upsert({
    where: { userId_storeId: { userId: ids.userId, storeId: ids.storeId } },
    create: { ...ids, status: MembershipStatus.ACTIVE },
    update: {}
  })
}

export async function ensureSystemRoles(
  prisma: PrismaClient
): Promise<Record<RoleName, { id: string }>> {
  const roles = {} as Record<RoleName, { id: string }>
  for (const name of Object.values(RoleNames)) roles[name] = await ensureSystemRole(prisma, name)
  return roles
}

// Idempotent and safe in production: it creates what is missing and changes nothing that exists.
export async function bootstrapOwner(
  prisma: PrismaClient,
  input: BootstrapInput
): Promise<BootstrapResult> {
  const roles = await ensureSystemRoles(prisma)
  const organization = await prisma.organization.upsert({
    where: { slug: slugify(input.organizationName) },
    create: { name: input.organizationName, slug: slugify(input.organizationName) },
    update: {}
  })
  const store = await ensureStore(prisma, organization.id, input.storeName)
  await ensureDefaultWarehouse(prisma, organization.id, store.id)
  const owner = await ensureUser(prisma, input.ownerEmail, input.ownerName)
  await ensureMembership(prisma, {
    userId: owner.id,
    organizationId: organization.id,
    storeId: store.id,
    roleId: roles[RoleNames.ADMIN].id
  })
  return { organizationId: organization.id, storeId: store.id, ownerId: owner.id }
}
