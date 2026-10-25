import { randomUUID } from 'node:crypto'

import { PrismaPg } from '@prisma/adapter-pg'
import pg from 'pg'

import { RoleNames, RolePresets } from '@platform/core/auth'
import { parseEncryptionKey } from '@platform/core/crypto'
import { WebhookSources } from '@platform/core/domain'

import { PrismaClient } from '../generated/client/client'
import { connectionUrls } from '../testing/connection-urls'

import { bootstrapOwner, ensureSystemRoles } from './bootstrap-owner'
import { loadDevFixtures } from './dev-fixtures'
import { PrismaService } from './prisma.service'
import { ProcessedWebhookEventsService } from './processed-webhook-events.service'

const urls = connectionUrls()
const runId = randomUUID().slice(0, 8)

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

const AUDIT_ID = `audit-${runId}`

afterAll(async () => {
  await withClient(urls.owner, async owner => {
    await owner.query('DELETE FROM audit_logs WHERE id = $1', [AUDIT_ID])
    await owner.query('DELETE FROM organizations WHERE slug LIKE $1', [`it-${runId}%`])
  })
})

describe('database roles', () => {
  it('lets platform_app read and write ordinary tables', async () => {
    await withClient(urls.app, async app => {
      await app.query(
        'INSERT INTO organizations (id, name, slug, updated_at) VALUES ($1, $2, $3, now())',
        [randomUUID(), 'Integration', `it-${runId}-roles`]
      )
      const { rows } = await app.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM organizations WHERE slug = $1',
        [`it-${runId}-roles`]
      )
      expect(rows[0]?.n).toBe(1)
    })
  })

  it('lets platform_app append to audit_logs and read it, but not change or delete', async () => {
    await withClient(urls.app, async app => {
      await app.query("INSERT INTO audit_logs (id, action) VALUES ($1, 'integration.test')", [
        AUDIT_ID
      ])
      const { rows } = await app.query('SELECT id FROM audit_logs WHERE id = $1', [AUDIT_ID])
      expect(rows).toHaveLength(1)
      await expect(
        app.query("UPDATE audit_logs SET action = 'x' WHERE id = $1", [AUDIT_ID])
      ).rejects.toThrow(/permission denied/)
      await expect(app.query('DELETE FROM audit_logs WHERE id = $1', [AUDIT_ID])).rejects.toThrow(
        /permission denied/
      )
    })
  })

  it('lets platform_worker delete from audit_logs', async () => {
    await withClient(urls.worker, async worker => {
      const result = await worker.query('DELETE FROM audit_logs WHERE id = $1', [AUDIT_ID])
      expect(result.rowCount).toBe(1)
    })
  })

  it('makes neither role a superuser, and only the worker bypasses RLS', async () => {
    await withClient(urls.owner, async owner => {
      const { rows } = await owner.query(
        "SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname LIKE 'platform\\_%' ORDER BY rolname"
      )
      expect(rows).toEqual([
        { rolname: 'platform_app', rolsuper: false, rolbypassrls: false, rolcanlogin: true },
        { rolname: 'platform_worker', rolsuper: false, rolbypassrls: true, rolcanlogin: true }
      ])
    })
  })
})

describe('schema shape', () => {
  it('has search_vector only on messages, customers and products', async () => {
    await withClient(urls.owner, async owner => {
      const { rows } = await owner.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.columns WHERE column_name = 'search_vector' ORDER BY 1"
      )
      expect(rows.map(row => row.table_name)).toEqual(['customers', 'messages', 'products'])
    })
  })

  it('names every table and column in snake_case, except Prisma implicit join tables', async () => {
    await withClient(urls.owner, async owner => {
      const { rows } = await owner.query(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name NOT LIKE '\\_%'
           AND (table_name !~ '^[a-z][a-z0-9_]*$' OR column_name !~ '^[a-z][a-z0-9_]*$')`
      )
      expect(rows).toEqual([])
    })
  })

  it('enforces the CSAT range and the pending invitation uniqueness', async () => {
    await withClient(urls.owner, async owner => {
      const { rows } = await owner.query<{ conname: string }>(
        "SELECT conname FROM pg_constraint WHERE conname = 'chk_csat_range' UNION ALL SELECT indexname FROM pg_indexes WHERE indexname = 'uq_invitations_pending'"
      )
      expect(rows.map(row => row.conname).sort()).toEqual([
        'chk_csat_range',
        'uq_invitations_pending'
      ])
    })
  })
})

describe('PrismaService', () => {
  const service = new PrismaService({ databaseUrl: urls.app, poolSize: 4 })

  beforeAll(() => service.onModuleInit())
  afterAll(() => service.onModuleDestroy())

  it('queries as platform_app through the driver adapter', async () => {
    const rows = await service.client.$queryRaw<{ current_user: string }[]>`SELECT current_user`
    expect(rows[0]?.current_user).toBe('platform_app')
  })

  it('answers replica() from the primary when there is no replica', async () => {
    const rows = await service.replica().$queryRaw<{ n: number }[]>`SELECT 1::int AS n`
    expect(rows[0]?.n).toBe(1)
  })

  it('rolls a transaction back as one unit', async () => {
    const slug = `it-${runId}-rollback`
    await expect(
      service.transaction(async tx => {
        await tx.organization.create({ data: { name: 'Rolled back', slug } })
        throw new Error('abort')
      })
    ).rejects.toThrow('abort')
    expect(await service.client.organization.count({ where: { slug } })).toBe(0)
  })

  it('exposes the tenant settings only inside a tenant transaction, and joins it', async () => {
    const read = async (): Promise<string | null> => {
      const rows = await service.client.$queryRaw<{ value: string | null }[]>`
        SELECT nullif(current_setting('app.store_ids', true), '') AS value`
      return rows[0]?.value ?? null
    }
    expect(await read()).toBeNull()

    const inside = await service.tenantTransaction(
      { storeIds: ['store-a', 'store-b'], organizationIds: ['org-a'] },
      async () => {
        const nested = await service.transaction(async tx => {
          const rows = await tx.$queryRaw<
            { value: string }[]
          >`SELECT current_setting('app.organization_ids', true) AS value`
          return rows[0]?.value
        })
        return { stores: await read(), organizations: nested }
      }
    )
    expect(inside).toEqual({ stores: 'store-a,store-b', organizations: 'org-a' })
    expect(await read()).toBeNull()
  })

  it('refuses to open a tenant transaction inside another one', async () => {
    const context = { storeIds: ['store-a'], organizationIds: [] }
    await expect(
      service.tenantTransaction(context, () =>
        service.tenantTransaction(context, () => Promise.resolve(1))
      )
    ).rejects.toThrow('already open')
  })

  it('rolls back a whole tenant transaction when its work throws', async () => {
    const slug = `it-${runId}-tenant`
    await expect(
      service.tenantTransaction({ storeIds: [], organizationIds: [] }, async () => {
        await service.client.organization.create({ data: { name: 'Tenant rollback', slug } })
        throw new Error('abort')
      })
    ).rejects.toThrow('abort')
    expect(await service.client.organization.count({ where: { slug } })).toBe(0)
  })
})

describe('ProcessedWebhookEventsService', () => {
  const prisma = new PrismaService({ databaseUrl: urls.app, poolSize: 8 })
  const events = new ProcessedWebhookEventsService(prisma)
  const eventId = (suffix: string): string => `it-${runId}-${suffix}`

  beforeAll(() => prisma.onModuleInit())
  afterAll(async () => {
    await withClient(urls.owner, owner =>
      owner.query('DELETE FROM processed_webhook_events WHERE event_id LIKE $1', [`it-${runId}-%`])
    )
    await prisma.onModuleDestroy()
  })

  it('runs the handler once and ignores the same event afterwards', async () => {
    const handler = jest.fn(() => Promise.resolve())
    const id = eventId('twice')

    expect(await events.runOnce(WebhookSources.RESEND, id, 'email.opened', handler)).toBe(true)
    expect(await events.runOnce(WebhookSources.RESEND, id, 'email.opened', handler)).toBe(false)

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('rolls the marker back when the handler throws, so the provider retry is processed', async () => {
    const id = eventId('retry')
    await expect(
      events.runOnce(WebhookSources.RESEND, id, 'email.bounced', () =>
        Promise.reject(new Error('redis down'))
      )
    ).rejects.toThrow('redis down')

    const handler = jest.fn(() => Promise.resolve())
    expect(await events.runOnce(WebhookSources.RESEND, id, 'email.bounced', handler)).toBe(true)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('runs the handler once when the same event arrives twice at the same time', async () => {
    const handler = jest.fn(() => new Promise<void>(resolve => setTimeout(resolve, 100)))
    const id = eventId('race')

    const results = await Promise.all([
      events.runOnce(WebhookSources.RESEND, id, 'email.opened', handler),
      events.runOnce(WebhookSources.RESEND, id, 'email.opened', handler)
    ])

    expect(results.filter(ran => ran)).toHaveLength(1)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('keeps the same event id of two sources apart', async () => {
    const handler = jest.fn(() => Promise.resolve())
    const id = eventId('sources')
    await withClient(urls.owner, owner =>
      owner.query(
        `INSERT INTO processed_webhook_events (source, event_id, type) VALUES ('other', $1, 't')`,
        [id]
      )
    )

    expect(await events.runOnce(WebhookSources.RESEND, id, 'email.opened', handler)).toBe(true)
  })
})

describe('owner bootstrap', () => {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urls.owner }) })
  const input = {
    ownerEmail: `owner-${runId}@example.com`,
    ownerName: 'Owner',
    organizationName: `it ${runId} bootstrap`,
    storeName: 'Tienda Principal'
  }

  afterAll(async () => {
    await prisma.membership.deleteMany({ where: { user: { email: input.ownerEmail } } })
    await prisma.user.deleteMany({ where: { email: input.ownerEmail } })
    await prisma.organization.deleteMany({
      where: { slug: { startsWith: `it-${runId}-bootstrap` } }
    })
    await prisma.$disconnect()
  })

  it('creates the owner with a working Admin membership, and running it twice duplicates nothing', async () => {
    const first = await bootstrapOwner(prisma, input)
    const second = await bootstrapOwner(prisma, input)
    expect(second).toEqual(first)

    expect(await prisma.organization.count({ where: { id: first.organizationId } })).toBe(1)
    expect(await prisma.store.count({ where: { organizationId: first.organizationId } })).toBe(1)
    expect(await prisma.storeSettings.count({ where: { storeId: first.storeId } })).toBe(1)
    expect(await prisma.retentionSettings.count({ where: { storeId: first.storeId } })).toBe(1)
    expect(await prisma.user.count({ where: { email: input.ownerEmail } })).toBe(1)

    const memberships = await prisma.membership.findMany({
      where: { userId: first.ownerId },
      include: { role: { include: { permissions: true } } }
    })
    expect(memberships).toHaveLength(1)
    expect(memberships[0]?.status).toBe('ACTIVE')
    expect(memberships[0]?.role.name).toBe(RoleNames.ADMIN)
    expect(memberships[0]?.role.permissions).toHaveLength(RolePresets[RoleNames.ADMIN].length)
  })

  it('creates each system role once, with the permissions of its preset', async () => {
    for (const name of Object.values(RoleNames)) {
      const roles = await prisma.role.findMany({
        where: { storeId: null, name },
        include: { permissions: true }
      })
      expect(roles).toHaveLength(1)
      expect(roles[0]?.permissions).toHaveLength(RolePresets[name].length)
    }
  })

  it('verifies the owner without a password column', async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: input.ownerEmail } })
    expect(user.emailVerified).toBe(true)
    expect(Object.keys(user)).not.toContain('passwordHash')
  })

  it('creates a system role once even when two runs race', async () => {
    await Promise.all([
      ensureSystemRoles(prisma),
      ensureSystemRoles(prisma),
      ensureSystemRoles(prisma)
    ])
    for (const name of Object.values(RoleNames)) {
      expect(await prisma.role.count({ where: { storeId: null, name } })).toBe(1)
    }
  })
})

describe('development fixtures', () => {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urls.owner }) })
  const key = parseEncryptionKey('11'.repeat(32))

  afterAll(() => prisma.$disconnect())

  it('load completely and a second run adds nothing', async () => {
    const counts = async (): Promise<number[]> => [
      await prisma.customer.count(),
      await prisma.conversation.count(),
      await prisma.message.count(),
      await prisma.product.count()
    ]
    await loadDevFixtures(prisma, key)
    const first = await counts()
    await loadDevFixtures(prisma, key)
    expect(await counts()).toEqual(first)
    const fixtureUsers = await prisma.user.count({
      where: {
        email: {
          in: ['admin@test.com', 'agent@test.com', 'viewer@test.com', 'multi-store@test.com']
        }
      }
    })
    expect(fixtureUsers).toBe(4)
  })
})
