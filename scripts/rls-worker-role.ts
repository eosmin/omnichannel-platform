import 'dotenv-flow/config'
import { argv, exit } from 'node:process'

import pg from 'pg'

import { loadOwnerDatabaseUrl, workerEnvForRoleScript } from './db-role-env'
import {
  allowedHostOf,
  alreadyAsRequested,
  confirmationOf,
  confirmProblem,
  connectionsProblem,
  connectionsSummary,
  flagProblem,
  forceConnectedOf,
  hostProblem,
  readReachedDatabases,
  readWorkerConnections,
  reachedDatabasesWarning,
  WORKER_ROLE,
  WORKER_ROLE_MODES,
  workerRoleProblem,
  workerRoleStatement,
  type WorkerRoleMode,
  type WorkerRoleRow
} from './lib/rls-worker-role'

// Takes BYPASSRLS away from the role of the worker (stage E of the RLS plan) or gives it back, so that the worker meets the same policies
// as the api. Run by the OWNER of the database, over DIRECT_DATABASE_URL, in the order of docs/RLS_ACTIVATION_RUNBOOK.md. It is not a
// migration on purpose: a migration would run in the deploy and change what the worker sees in production without the owner.
// PostgreSQL lets only a superuser change BYPASSRLS: with an owner that is not one, the statement is refused and nothing changes.
// A ROLE BELONGS TO THE WHOLE SERVER, not to one database: the change reaches every database of the cluster that the role connects to
// (the production one and any other beside it). --confirm names the database the command is connected to; the list of databases it
// prints before changing anything is what the change reaches.
//
//   pnpm db:rls:worker-role status                         what the role is right now (default; it never changes anything)
//   pnpm db:rls:worker-role nobypass --confirm=<database>  ALTER ROLE platform_worker NOBYPASSRLS
//   pnpm db:rls:worker-role bypass --confirm=<database>    the way back: ALTER ROLE platform_worker BYPASSRLS
//
// A mode that changes the role runs only with --confirm=<the name of the database the URL points at>, compared with current_database()
// of the connection: a command pointed at the wrong database stops. It says host, database and role before it changes anything, and
// does nothing (and says so) when the role already is as asked. No migration, `db:migrate` or deploy step runs it.
//
// `nobypass` also refuses while a session of the role is open (the workers are not stopped: one that runs with the flag off would read
// no row and say nothing), and when the sessions cannot be seen; --force-connected is for the rehearsal. A host that is not this machine
// needs --allow-host=<host>. The check is a snapshot: the workers must stay stopped until the command ends (the runbook, step 3b).
//
// Idempotent. Stop the workers before `nobypass` and start them with WORKER_RLS_CONTEXT=true after it: a job with no context reads no
// row once the role is bound. The way back is the inverse: flag off and restart first, `bypass` after, or the worker will not start.
const requested = argv.slice(2).find(arg => !arg.startsWith('--')) ?? 'status'
const mode: WorkerRoleMode | undefined = WORKER_ROLE_MODES.find(
  candidate => candidate === requested
)
if (mode === undefined) {
  console.error(`unknown mode "${requested}": use ${WORKER_ROLE_MODES.join(', ')}`)
  exit(2)
}

const url = loadOwnerDatabaseUrl()
if (url === undefined) {
  console.error('DIRECT_DATABASE_URL (the owner of the database) is required and must be a URL')
  exit(2)
}

async function readRole(client: pg.Client): Promise<WorkerRoleRow | undefined> {
  const { rows } = await client.query<WorkerRoleRow>(
    'SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = $1',
    [WORKER_ROLE]
  )
  return rows[0]
}

async function run(selected: WorkerRoleMode): Promise<void> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    const target = new URL(url ?? '')
    console.log(`database ${decodeURIComponent(target.pathname.slice(1))} on ${target.hostname}`)
    const before = await readRole(client)
    if (before === undefined) {
      console.error(`the role ${WORKER_ROLE} does not exist. Nothing changed.`)
      process.exitCode = 1
      return
    }
    const statement = workerRoleStatement(selected)
    const current = await client.query<{ name: string }>('SELECT current_database() AS name')
    const database = current.rows[0]?.name ?? ''
    // Before the confirmation, so that a refusal shows it too: the databases of the server where the role can connect
    const reached = await readReachedDatabases(client)
    console.log(reachedDatabasesWarning(reached, database))
    // Every mode says how many workers are connected right now (for `status`, that is the answer to "are they stopped?")
    const connections = await readWorkerConnections(client)
    console.log(connectionsSummary(connections))
    if (statement !== null) {
      const refused =
        flagProblem(selected, workerEnvForRoleScript()) ??
        hostProblem(selected, target.hostname, allowedHostOf(argv)) ??
        confirmProblem(selected, confirmationOf(argv), database) ??
        connectionsProblem(selected, connections, forceConnectedOf(argv))
      if (refused !== undefined) {
        console.error(`${refused}. Nothing changed.`)
        // Not exit(): the finally below must close the connection of the owner
        process.exitCode = 2
        return
      }
      console.log(
        `about to change: host ${target.hostname}, database ${database}, role ${WORKER_ROLE}`
      )
      if (alreadyAsRequested(selected, before)) {
        console.log(`${selected}: the role already is as asked, nothing changed`)
      } else {
        try {
          await client.query(statement)
          console.log(`${selected}: ${statement}`)
        } catch (error) {
          const code = (error as { code?: string }).code
          console.error(
            `${statement} failed${code === undefined ? '' : ` (SQLSTATE ${code})`}${
              code === '42501' ? ': only a superuser may change BYPASSRLS' : ''
            }: ${error instanceof Error ? error.message : String(error)}. Nothing changed.`
          )
          process.exitCode = 1
          return
        }
      }
    }
    const row = await readRole(client)
    console.log(
      `${WORKER_ROLE}: bypassrls=${String(row?.rolbypassrls)} superuser=${String(row?.rolsuper)} canlogin=${String(row?.rolcanlogin)} (${
        workerRoleProblem(row) === undefined
          ? 'row security binds it'
          : 'row security does not bind it'
      })`
    )
    // The command says what it was asked to do: a mode that did not leave the role as asked is a failure, not a quiet success
    if (selected === 'nobypass' && workerRoleProblem(row) !== undefined) process.exitCode = 1
    if (selected === 'bypass' && row?.rolbypassrls !== true) process.exitCode = 1
  } finally {
    await client.end()
  }
}

await run(mode)
