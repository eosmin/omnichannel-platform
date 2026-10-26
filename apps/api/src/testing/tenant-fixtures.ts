import { randomUUID } from 'node:crypto'

import type pg from 'pg'

import type { Permission } from '@platform/core/auth'

type AsOwner = <T>(work: (client: pg.Client) => Promise<T>) => Promise<T>

export interface TestStore {
  organizationId: string
  storeId: string
}

// Rows for the tenancy suites, written as the database owner (the api cannot create stores yet).
// Everything carries the run id, and removing the organizations removes the rest (cascade).
export interface TenantFixtures {
  createStore(): Promise<TestStore>
  createRole(storeId: string, permissions: readonly Permission[]): Promise<string>
  addMember(
    userId: string,
    store: TestStore,
    roleId: string,
    status?: 'ACTIVE' | 'REVOKED'
  ): Promise<string>
  setPermissions(roleId: string, permissions: readonly Permission[]): Promise<void>
  removeMember(membershipId: string): Promise<void>
  deleteAll(): Promise<void>
}

export function tenantFixtures(asOwner: AsOwner, runId: string): TenantFixtures {
  let counter = 0
  const next = (): string => {
    counter += 1
    return `it-${runId}-${counter}`
  }

  return {
    async createStore(): Promise<TestStore> {
      const slug = next()
      const organizationId = randomUUID()
      const storeId = randomUUID()
      await asOwner(async client => {
        await client.query(
          `INSERT INTO organizations (id, name, slug, updated_at) VALUES ($1, $2, $2, now())`,
          [organizationId, slug]
        )
        await client.query(
          `INSERT INTO stores (id, organization_id, name, slug, updated_at)
           VALUES ($1, $2, $3, $3, now())`,
          [storeId, organizationId, slug]
        )
      })
      return { organizationId, storeId }
    },

    async createRole(storeId: string, permissions: readonly Permission[]): Promise<string> {
      const roleId = randomUUID()
      await asOwner(async client => {
        await client.query(
          `INSERT INTO roles (id, store_id, name, is_system, updated_at) VALUES ($1, $2, $3, false, now())`,
          [roleId, storeId, next()]
        )
        for (const permission of permissions) {
          await client.query(`INSERT INTO permissions (id, name, role_id) VALUES ($1, $2, $3)`, [
            randomUUID(),
            permission,
            roleId
          ])
        }
      })
      return roleId
    },

    async addMember(
      userId: string,
      store: TestStore,
      roleId: string,
      status: 'ACTIVE' | 'REVOKED' = 'ACTIVE'
    ): Promise<string> {
      const membershipId = randomUUID()
      await asOwner(client =>
        client.query(
          `INSERT INTO memberships (id, user_id, organization_id, store_id, role_id, status, revoked_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, ${status === 'REVOKED' ? 'now()' : 'NULL'}, now())`,
          [membershipId, userId, store.organizationId, store.storeId, roleId, status]
        )
      )
      return membershipId
    },

    async setPermissions(roleId: string, permissions: readonly Permission[]): Promise<void> {
      await asOwner(async client => {
        await client.query(`DELETE FROM permissions WHERE role_id = $1`, [roleId])
        for (const permission of permissions) {
          await client.query(`INSERT INTO permissions (id, name, role_id) VALUES ($1, $2, $3)`, [
            randomUUID(),
            permission,
            roleId
          ])
        }
      })
    },

    async removeMember(membershipId: string): Promise<void> {
      await asOwner(client =>
        client.query(
          `UPDATE memberships SET status = 'REVOKED', revoked_at = now(), updated_at = now() WHERE id = $1`,
          [membershipId]
        )
      )
    },

    deleteAll(): Promise<void> {
      return asOwner(async client => {
        await client.query(`DELETE FROM organizations WHERE slug LIKE $1`, [`it-${runId}-%`])
      })
    }
  }
}
