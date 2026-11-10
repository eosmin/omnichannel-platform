import { RoleNames } from '@platform/core/auth'

import type { PrismaClient } from '../generated/client/client'

import { ensureMembership, ensureStore, ensureSystemRoles, ensureUser } from './bootstrap-owner'

// What a person of the browser suite is: the three roles of the fixtures, and the one who belongs to both
// stores (administrator of the first, agent of the second), like `multi-store@test.com`.
export const E2ePersonRoles = {
  ADMIN: 'admin',
  AGENT: 'agent',
  VIEWER: 'viewer',
  MULTI_STORE: 'multi'
} as const
export type E2ePersonRole = (typeof E2ePersonRoles)[keyof typeof E2ePersonRoles]

export interface E2ePerson {
  email: string
  name: string
  role: E2ePersonRole
}

// Test people for the browser suite only: the suite asks for them (`loadE2ePeople`) and nothing else loads
// them, so the development fixtures, the seeds and the isolation suites never see them. The magic link
// allows a few a minute per address, so each spec file signs in as people of its own instead of waiting on
// the ones it shares. They have the same minimum permissions as the fixture people of their role (the system
// role of each, in the stores of `loadDevFixtures`, which must have run), no password and no other data.
// Idempotent.
export async function loadE2ePeople(
  prisma: PrismaClient,
  people: readonly E2ePerson[]
): Promise<void> {
  if (people.length === 0) return
  const roles = await ensureSystemRoles(prisma)
  const organization = await prisma.organization.findUniqueOrThrow({ where: { slug: 'test-org' } })
  const main = await ensureStore(prisma, organization.id, 'Main Store')
  const escalon = await ensureStore(prisma, organization.id, 'Tienda Escalón')
  for (const person of people) {
    const user = await ensureUser(prisma, person.email, person.name)
    const inMain =
      person.role === E2ePersonRoles.AGENT
        ? RoleNames.AGENT
        : person.role === E2ePersonRoles.VIEWER
          ? RoleNames.VIEWER
          : RoleNames.ADMIN
    await ensureMembership(prisma, {
      userId: user.id,
      organizationId: organization.id,
      storeId: main.id,
      roleId: roles[inMain].id
    })
    if (person.role === E2ePersonRoles.MULTI_STORE) {
      await ensureMembership(prisma, {
        userId: user.id,
        organizationId: organization.id,
        storeId: escalon.id,
        roleId: roles[RoleNames.AGENT].id
      })
    }
  }
}
