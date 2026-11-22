import pg from 'pg'

import {
  PrismaService,
  REPLICA_ROLE_FACTS_SQL,
  replicaRoleProblem,
  type ReplicaRoleFacts
} from '@platform/core/database'
import {
  connectionUrls,
  replicaConnectionUrl,
  DatabaseRoles
} from '@platform/core/database-testing'

// The check of the start of the api (libs/core/database/src/replica-role.ts), run against a real database: the unit spec reads
// the decision with invented facts, this one proves that the SQL that reads the facts is valid and answers what the roles of
// the migration 20270122000000 are. Without it a mistake in the SQL would show only when the owner turns the activation on and
// the api refuses to start. DATABASE_REPLICA_URL is removed from the env of these suites (helpers/env.ts), so the handle of the
// replica is built here.
async function factsOf(connectionString: string): Promise<ReplicaRoleFacts> {
  const client = new pg.Client({ connectionString })
  await client.connect()
  try {
    const { rows } = await client.query<ReplicaRoleFacts>(REPLICA_ROLE_FACTS_SQL)
    expect(rows).toHaveLength(1)
    return rows[0] as ReplicaRoleFacts
  } finally {
    await client.end()
  }
}

describe('the start check of the replica role', () => {
  it('reads the read only role as a role that cannot write and does not skip row security', async () => {
    const facts = await factsOf(replicaConnectionUrl())
    expect(facts).toEqual({
      roleName: DatabaseRoles.REPLICA,
      isSuperuser: false,
      bypassesRls: false,
      canWrite: false,
      inRecovery: false
    })
    expect(replicaRoleProblem(facts)).toBeNull()
  })

  it('reads the role of the api as one that can write, on a server that is not a standby', async () => {
    const facts = await factsOf(connectionUrls().app)
    expect(facts).toMatchObject({
      roleName: DatabaseRoles.APP,
      isSuperuser: false,
      bypassesRls: false,
      canWrite: true,
      inRecovery: false
    })
    expect(replicaRoleProblem(facts)).toContain(DatabaseRoles.APP)
  })

  it('refuses to start with the role of the api as the replica, and starts with the read only role', async () => {
    const refused = new PrismaService({
      databaseUrl: connectionUrls().app,
      replicaUrl: connectionUrls().app,
      verifyReplicaRole: true
    })
    await expect(refused.onModuleInit()).rejects.toThrow(
      new RegExp(`${DatabaseRoles.APP}.*${DatabaseRoles.REPLICA}`)
    )

    const accepted = new PrismaService({
      databaseUrl: connectionUrls().app,
      replicaUrl: replicaConnectionUrl(),
      verifyReplicaRole: true
    })
    try {
      await expect(accepted.onModuleInit()).resolves.toBeUndefined()
    } finally {
      await accepted.onModuleDestroy()
    }
  })

  it('does not look at the replica when the option is off', async () => {
    const unchecked = new PrismaService({
      databaseUrl: connectionUrls().app,
      replicaUrl: connectionUrls().app
    })
    try {
      await expect(unchecked.onModuleInit()).resolves.toBeUndefined()
    } finally {
      await unchecked.onModuleDestroy()
    }
  })
})
