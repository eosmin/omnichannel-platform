import { randomUUID } from 'node:crypto'

import { Test } from '@nestjs/testing'
import pg from 'pg'

import { AuditAction } from '@platform/core/audit'
import { DatabaseModule } from '@platform/core/database'
import { connectionUrls } from '@platform/core/database-testing'
import { LoggerModule } from '@platform/core/logger'
import { MetricsModule } from '@platform/core/metrics-module'

import { AuditModule } from './audit.module'
import { AuditService } from './audit.service'

const urls = connectionUrls()
const RESOURCE = `it-shutdown-${randomUUID().slice(0, 8)}`

// A process that is told to stop with an entry still being written: the entry has to reach the
// database before the connection to it is closed. (Both the audit service and the Prisma service
// do their work when the module is destroyed, so their order matters.)
describe('stopping the process with audit entries in flight', () => {
  async function owner<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: urls.owner })
    await client.connect()
    try {
      return await work(client)
    } finally {
      await client.end()
    }
  }

  afterAll(() =>
    owner(client => client.query('DELETE FROM audit_logs WHERE resource_type = $1', [RESOURCE]))
  )

  it('writes them first, every time', async () => {
    const attempts = 8
    for (let i = 0; i < attempts; i += 1) {
      const moduleRef = await Test.createTestingModule({
        imports: [
          LoggerModule.forRoot({ level: 'fatal', pretty: false }),
          MetricsModule,
          DatabaseModule.forRoot({ databaseUrl: urls.app, poolSize: 2 }),
          AuditModule
        ]
      }).compile()
      const app = moduleRef.createNestApplication()
      await app.init()
      app.get(AuditService).log({
        action: AuditAction.USER_LOGOUT,
        actor: { system: true },
        resourceType: RESOURCE,
        resourceId: `attempt-${i}`
      })

      await app.close() // Straight away, with the write still in flight
    }

    const result = await owner(client =>
      client.query<{ n: string }>('SELECT count(*) AS n FROM audit_logs WHERE resource_type = $1', [
        RESOURCE
      ])
    )
    expect(Number(result.rows[0]?.n)).toBe(attempts)
  })
})
