import { randomUUID } from 'node:crypto'

import { Controller, Get, type INestApplication, Param } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import pg from 'pg'

import { AuditAction } from '@platform/core/audit'
import { DatabaseModule, PrismaService } from '@platform/core/database'
import { connectionUrls } from '@platform/core/database-testing'
import { LoggerModule } from '@platform/core/logger'
import { MetricsModule } from '@platform/core/metrics-module'

import { Audit } from './audit.decorator'
import { AuditModule } from './audit.module'
import { AuditService } from './audit.service'

const urls = connectionUrls()
const runId = randomUUID().slice(0, 8)
const RESOURCE = `it-${runId}`

interface Row {
  action: string
  user_id: string | null
  store_id: string | null
  organization_id: string | null
  resource_type: string | null
  resource_id: string | null
  metadata: unknown
  ip_address: string | null
  user_agent: string | null
}

// Mounted like a real route: somebody is logged in (a middleware stands in for the AuthGuard) and
// the handler is decorated
@Controller()
class ThingsController {
  @Audit(AuditAction.CUSTOMER_VIEWED, { resourceType: RESOURCE })
  @Get('things/:id')
  one(@Param('id') id: string): { id: string } {
    return { id }
  }

  @Audit(AuditAction.CUSTOMER_VIEWED, { resourceType: RESOURCE })
  @Get('things/fail/now')
  fail(): never {
    throw new Error('the handler failed')
  }
}

describe('the audit trail, against the database', () => {
  let app: INestApplication
  let audit: AuditService
  let userId: string

  async function asOwner<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: urls.owner })
    await client.connect()
    try {
      return await work(client)
    } finally {
      await client.end()
    }
  }

  async function rowsOf(resourceId: string): Promise<Row[]> {
    await audit.onModuleDestroy() // Waits for the writes in flight
    const result = await asOwner(client =>
      client.query<Row>('SELECT * FROM audit_logs WHERE resource_type = $1 AND resource_id = $2', [
        RESOURCE,
        resourceId
      ])
    )
    return result.rows
  }

  beforeAll(async () => {
    userId = randomUUID()
    await asOwner(client =>
      client.query(
        `INSERT INTO users (id, email, name, updated_at) VALUES ($1, $2, 'Audit Test', now())`,
        [userId, `it-${runId}-audit@example.com`]
      )
    )
    const moduleRef = await Test.createTestingModule({
      imports: [
        LoggerModule.forRoot({ level: 'fatal', pretty: false }),
        MetricsModule,
        DatabaseModule.forRoot({ databaseUrl: urls.app, poolSize: 4 }),
        AuditModule
      ],
      controllers: [ThingsController]
    }).compile()
    app = moduleRef.createNestApplication()
    app.use((request: { user?: unknown; store?: unknown }, _res: unknown, next: () => void) => {
      request.user = { id: userId, sessionFamilyId: randomUUID(), email: 'a@example.com' }
      request.store = { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }
      next()
    })
    await app.listen(0)
    audit = app.get(AuditService)
  })

  afterAll(async () => {
    await asOwner(async client => {
      await client.query('DELETE FROM audit_logs WHERE resource_type = $1', [RESOURCE])
      await client.query('DELETE FROM audit_logs WHERE user_id = $1', [userId])
      await client.query('DELETE FROM users WHERE id = $1', [userId])
    })
    await app.close()
  })

  it('writes an entry as the role the api runs with', async () => {
    const resourceId = randomUUID()

    audit.log({
      action: AuditAction.CUSTOMER_EXPORTED,
      actor: { userId },
      storeId: 'ffffffff-ffff-4fff-8fff-fffffffffffe',
      resourceType: RESOURCE,
      resourceId,
      metadata: { rows: 12 },
      ipAddress: '203.0.113.9',
      userAgent: 'jest'
    })

    expect(await rowsOf(resourceId)).toMatchObject([
      {
        action: 'customer.exported',
        user_id: userId,
        store_id: 'ffffffff-ffff-4fff-8fff-fffffffffffe',
        metadata: { rows: 12 },
        ip_address: '203.0.113.9',
        user_agent: 'jest'
      }
    ])
  })

  it('writes the action of the system with no user', async () => {
    const resourceId = randomUUID()

    audit.log({
      action: AuditAction.ORGANIZATION_CREATED,
      actor: { system: true },
      resourceType: RESOURCE,
      resourceId
    })

    const [row] = await rowsOf(resourceId)
    expect(row?.user_id).toBeNull()
  })

  it('is append-only for the api: it cannot change or delete an entry', async () => {
    const resourceId = randomUUID()
    audit.log({
      action: AuditAction.USER_LOGOUT,
      actor: { userId },
      resourceType: RESOURCE,
      resourceId
    })
    await rowsOf(resourceId)
    const prisma = app.get(PrismaService)

    await expect(
      prisma.client
        .$executeRaw`UPDATE audit_logs SET action = 'tampered' WHERE resource_id = ${resourceId}`
    ).rejects.toThrow(/permission denied/i)
    await expect(
      prisma.client.$executeRaw`DELETE FROM audit_logs WHERE resource_id = ${resourceId}`
    ).rejects.toThrow(/permission denied/i)
    expect((await rowsOf(resourceId))[0]?.action).toBe('user.logout')
  })

  it('does not throw at the caller when the database refuses the entry', async () => {
    // A user that does not exist breaks the foreign key of audit_logs.user_id
    expect(() =>
      audit.log({
        action: AuditAction.USER_LOGOUT,
        actor: { userId: randomUUID() },
        resourceType: RESOURCE,
        resourceId: 'refused'
      })
    ).not.toThrow()

    expect(await rowsOf('refused')).toEqual([])
  })

  it('stores metadata that was too big as a note, and the row is still written', async () => {
    const resourceId = randomUUID()

    audit.log({
      action: AuditAction.SETTINGS_CHANGED,
      actor: { userId },
      resourceType: RESOURCE,
      resourceId,
      metadata: { blob: 'x'.repeat(50_000) }
    })

    const [row] = await rowsOf(resourceId)
    expect(row?.metadata).toMatchObject({ truncated: true })
  })

  describe('@Audit on a route', () => {
    it('writes the entry once the handler answered, with the id from the path', async () => {
      const id = randomUUID()
      const url = await app.getUrl()

      const response = await fetch(`${url}/things/${id}`, {
        headers: { 'user-agent': 'jest-http' }
      })

      expect(response.status).toBe(200)
      expect(await rowsOf(id)).toMatchObject([
        {
          action: 'customer.viewed',
          user_id: userId,
          store_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          resource_type: RESOURCE,
          user_agent: 'jest-http'
        }
      ])
    })

    it('writes nothing when the handler fails', async () => {
      const url = await app.getUrl()
      const count = async (): Promise<number> => {
        await audit.onModuleDestroy()
        const result = await asOwner(client =>
          client.query<{ n: string }>(
            `SELECT count(*) AS n FROM audit_logs WHERE resource_type = $1 AND action = 'customer.viewed'`,
            [RESOURCE]
          )
        )
        return Number(result.rows[0]?.n)
      }
      const before = await count()

      const response = await fetch(`${url}/things/fail/now`)

      expect(response.status).toBe(500)
      expect(await count()).toBe(before)
    })
  })
})
