import 'dotenv-flow/config'
import { argv, exit } from 'node:process'

import pg from 'pg'

import { loadOwnerDatabaseUrl } from './db-role-env'
import {
  NOT_VALID_CONSTRAINTS,
  label,
  refusalToChange,
  revertToNotValid,
  statusOf,
  validateConstraints
} from './lib/not-valid-constraints'

// Validates, outside a transaction, the CHECK constraints that migrations added NOT VALID (scripts/lib/not-valid-constraints.ts).
// Run by the OWNER of the database over DIRECT_DATABASE_URL, in a maintenance window. Idempotent: a valid constraint is skipped,
// so a run that stopped on a lock timeout is finished by running it again. Runbook: docs/NOT_VALID_CONSTRAINTS_RUNBOOK.md.
//
//   pnpm db:constraints:validate status   which are valid and which are not (default; changes nothing)
//   pnpm db:constraints:validate run --confirm=<database>      VALIDATE CONSTRAINT on each, one statement and one table at a time
//   pnpm db:constraints:validate revert --confirm=<database>   the way back: drop and add again NOT VALID (no scan)
const MODES = ['status', 'run', 'revert'] as const

const requested = argv[2] ?? 'status'
const mode = MODES.find(candidate => candidate === requested)
if (mode === undefined) {
  console.error(`unknown mode "${requested}": use ${MODES.join(', ')}`)
  exit(2)
}

const url = loadOwnerDatabaseUrl()
if (url === undefined) {
  console.error('DIRECT_DATABASE_URL (the owner of the database) is required and must be a URL')
  exit(2)
}

async function run(selected: (typeof MODES)[number]): Promise<void> {
  const target = new URL(url ?? '')
  const databaseName = decodeURIComponent(target.pathname.slice(1))
  console.log(`database ${databaseName} on ${target.hostname}`)
  // Before any connection: a refused run never touches the server
  if (selected !== 'status') {
    const refusal = refusalToChange(databaseName, argv.slice(3))
    if (refusal !== null) {
      console.error(`${refusal}. Nothing changed.`)
      process.exitCode = 2
      return
    }
  }
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    if (selected === 'run') {
      for (const outcome of await validateConstraints(client, NOT_VALID_CONSTRAINTS)) {
        const detail =
          outcome.result === 'violated'
            ? `${outcome.violatingRows} row(s) break it: fix or move them (runbook), then run again`
            : outcome.result === 'lock-timeout'
              ? 'could not get its lock in time: run again'
              : ''
        console.log(
          `${label(outcome.ref)}: ${outcome.result}${detail === '' ? '' : ` (${detail})`}`
        )
        if (outcome.result === 'violated' || outcome.result === 'lock-timeout') process.exitCode = 1
      }
    }
    if (selected === 'revert') {
      for (const constraint of NOT_VALID_CONSTRAINTS) {
        const result = await revertToNotValid(client, constraint)
        console.log(`${label(constraint)}: ${result}`)
        if (result === 'lock-timeout') process.exitCode = 1
      }
    }
    let notValid = 0
    for (const constraint of NOT_VALID_CONSTRAINTS) {
      const { state } = await statusOf(client, constraint)
      if (state !== 'valid') notValid += 1
      if (selected === 'status' || state !== 'valid') console.log(`${label(constraint)}: ${state}`)
    }
    console.log(
      `${NOT_VALID_CONSTRAINTS.length - notValid} of ${NOT_VALID_CONSTRAINTS.length} constraints are valid`
    )
  } finally {
    await client.end()
  }
}

await run(mode)
