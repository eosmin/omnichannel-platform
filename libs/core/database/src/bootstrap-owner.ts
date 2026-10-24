import { RoleNames, RolePresets, type RoleName } from '@platform/core/auth'
import { MembershipStatus } from '@platform/core/domain'

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
  const owner = await ensureUser(prisma, input.ownerEmail, input.ownerName)
  await ensureMembership(prisma, {
    userId: owner.id,
    organizationId: organization.id,
    storeId: store.id,
    roleId: roles[RoleNames.ADMIN].id
  })
  return { organizationId: organization.id, storeId: store.id, ownerId: owner.id }
}
