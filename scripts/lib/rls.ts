// Row-Level Security coverage (TDD_01 section 3.2, layer 3): every table of the schema is accounted for, so a new table cannot
// reach the database without a decision about its isolation. The pure functions of check-rls-coverage.ts.
//
// A table is one of:
//   covered   a migration gave it the policy `<table>_tenant` (rls_apply_policy, or an explicit CREATE POLICY of that name)
//   global    never gets a policy, for a reason that is written down (identity and bootstrap tables the guards read before any
//             tenant context exists, rows of a person and not of a store)
//   pending   gets its policy in the migration of a later phase of the RLS step. The list can only shrink: the check fails as
//             soon as a pending table is covered (remove the line) and for a table that is neither covered nor listed.

export type RlsScope = 'store' | 'organization' | 'both' | 'none'

export interface RlsTable {
  model: string
  table: string
  scope: RlsScope
}

export type RlsExemption =
  { kind: 'global'; reason: string } | { kind: 'pending'; phase: number; reason: string }

const MODEL_BLOCK = /^model (\w+) \{([\s\S]*?)^\}/gm
const TABLE_MAP = /@@map\(\s*"(\w+)"\s*\)/
const STORE_ID_COLUMN = /@map\(\s*"store_id"\s*\)/
const ORGANIZATION_ID_COLUMN = /@map\(\s*"organization_id"\s*\)/
// A comment starts at `//` at the beginning of a line or after a blank, never inside `https://...`
const LINE_COMMENT = /(^|\s)\/\/.*$/gm

export function schemaTables(schema: string): RlsTable[] {
  return [...schema.matchAll(MODEL_BLOCK)]
    .map(([, model, body]) => {
      const text = (body ?? '').replace(LINE_COMMENT, '$1')
      const store = STORE_ID_COLUMN.test(text)
      const organization = ORGANIZATION_ID_COLUMN.test(text)
      const scope: RlsScope =
        store && organization ? 'both' : store ? 'store' : organization ? 'organization' : 'none'
      // Every model declares @@map (TDD_02 section on naming); one that does not is read by its model name so it is still seen
      return { model: model ?? '', table: TABLE_MAP.exec(text)?.[1] ?? model ?? '', scope }
    })
    .sort((a, b) => a.table.localeCompare(b.table))
}

// Prisma creates a join table for an implicit many-to-many relation (`Tag[] @relation("CustomerTags")` on one model and
// `Customer[] @relation("CustomerTags")` on the other): `_CustomerTags`, with the two ids in the columns A and B and no model of
// its own. It carries no store column, so its policy goes through the rows it joins; it is still a table with a policy.
const LIST_RELATION = /^\s*\w+\s+\w+\[\]\s+@relation\(\s*"(\w+)"\s*\)/gm
export function implicitJoinTables(schema: string): string[] {
  const text = schema.replace(LINE_COMMENT, '$1')
  const sides = new Map<string, number>()
  for (const [, name] of text.matchAll(LIST_RELATION)) {
    sides.set(name ?? '', (sides.get(name ?? '') ?? 0) + 1)
  }
  return [...sides]
    .filter(([, count]) => count === 2)
    .map(([name]) => `_${name}`)
    .sort()
}

export interface MigrationSql {
  name: string
  sql: string
}

const SQL_COMMENT = /--.*$/gm
const APPLY_CALL = /rls_apply_policy\(\s*'(\w+)'/g
const DROP_CALL = /rls_drop_policy\(\s*'(\w+)'/g
const CREATE_POLICY = /CREATE\s+POLICY\s+"?(\w+)"?\s+ON\s+(?:public\.)?"?(\w+)"?/gi
const DROP_POLICY = /DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?\s+ON\s+(?:public\.)?"?(\w+)"?/gi

// The tables that have their `<table>_tenant` policy once every migration ran, in order. The migrations are the source of truth,
// not a list kept by hand: a later migration that drops the policy uncovers the table again.
export function coveredTables(migrations: readonly MigrationSql[]): Set<string> {
  const covered = new Set<string>()
  const ordered = [...migrations].sort((a, b) => a.name.localeCompare(b.name))
  for (const { sql } of ordered) {
    const text = sql.replace(SQL_COMMENT, '')
    // Statements in file order, so that a create followed by a drop inside one file nets out
    const events: Array<{ at: number; table: string; add: boolean }> = []
    for (const m of text.matchAll(APPLY_CALL))
      events.push({ at: m.index, table: m[1] ?? '', add: true })
    for (const m of text.matchAll(DROP_CALL))
      events.push({ at: m.index, table: m[1] ?? '', add: false })
    for (const m of text.matchAll(CREATE_POLICY)) {
      if (m[1] === `${m[2]}_tenant`) events.push({ at: m.index, table: m[2] ?? '', add: true })
    }
    for (const m of text.matchAll(DROP_POLICY)) {
      if (m[1] === `${m[2]}_tenant`) events.push({ at: m.index, table: m[2] ?? '', add: false })
    }
    for (const event of events.sort((a, b) => a.at - b.at)) {
      if (event.add) covered.add(event.table)
      else covered.delete(event.table)
    }
  }
  return covered
}

export interface RlsReport {
  // A table with no policy that is not listed: decide it (policy, global or pending) in the same change that adds it
  unclassified: string[]
  // Listed and covered already, or listed and not in the schema, or malformed
  stale: string[]
  // A policy on a table that is not in the schema
  orphanPolicies: string[]
}

export function checkRlsCoverage(
  tables: readonly RlsTable[],
  covered: ReadonlySet<string>,
  exemptions: Readonly<Record<string, RlsExemption>>,
  phases: readonly number[],
  joinTables: readonly string[] = []
): RlsReport {
  const names = new Set([...tables.map(t => t.table), ...joinTables])
  const unclassified: string[] = []
  const stale: string[] = []
  for (const { table } of tables) {
    const exemption = exemptions[table]
    if (covered.has(table)) {
      if (exemption?.kind === 'pending') {
        stale.push(`${table}: has its policy, remove it from the pending list`)
      }
      if (exemption?.kind === 'global') {
        stale.push(`${table}: has a policy and is listed as global, pick one`)
      }
    } else if (exemption === undefined) {
      unclassified.push(table)
    } else if (exemption.reason.trim() === '') {
      stale.push(`${table}: the exemption has no reason`)
    } else if (exemption.kind === 'pending' && !phases.includes(exemption.phase)) {
      stale.push(`${table}: pending for phase ${exemption.phase}, which the plan does not have`)
    }
  }
  // A join table is decided like any other: a policy, or a reason in the list
  for (const table of joinTables) {
    if (!covered.has(table) && exemptions[table] === undefined) unclassified.push(table)
  }
  for (const table of Object.keys(exemptions)) {
    if (!names.has(table)) stale.push(`${table}: listed but not a table of the schema`)
  }
  return {
    unclassified,
    stale,
    orphanPolicies: [...covered].filter(table => !names.has(table)).sort()
  }
}

// The api role is never allowed to skip row security (the worker is created with BYPASSRLS and loses it by hand, in stage E: see
// WORKER_ALTER below). A migration that grants BYPASSRLS to platform_app, makes it a superuser, puts it in another role or makes it the owner of a table defeats
// the whole mechanism.
const ROLE_ALTER =
  /\b(?:ALTER|CREATE)\s+(?:ROLE|USER)\s+(?:IF\s+EXISTS\s+)?"?platform_app"?[^;]*;/gi
const ROLE_GRANT = /\bGRANT\s+(?:(?!\bON\b)[^;])*\bTO\s+[^;]*\bplatform_app\b[^;]*;/gi
const OWNER_TO = /\bOWNER\s+TO\s+"?platform_app"?/gi
// The bypass of the worker is changed by the owner with `pnpm db:rls:worker-role` (stage E), never by a migration: a migration runs by
// itself in the deploy and would change what the worker sees in production without the owner. Creating the role stays allowed
const WORKER_ALTER =
  /\bALTER\s+(?:ROLE|USER)\s+(?:IF\s+EXISTS\s+)?"?platform_worker"?[^;]*(?:;|$)/gi
const WORKER_HEAD = /^\s*ALTER\s+(?:ROLE|USER)\s+(?:IF\s+EXISTS\s+)?"?platform_worker"?/i
const WORKER_GRANT = /\bGRANT\s+(?:(?!\bON\b)[^;])*\bTO\s+[^;]*\bplatform_worker\b[^;]*;/gi
export function roleViolations(migrations: readonly MigrationSql[]): string[] {
  const problems: string[] = []
  for (const { name, sql } of migrations) {
    const text = sql.replace(SQL_COMMENT, '')
    for (const statement of text.match(ROLE_ALTER) ?? []) {
      if (
        /(?<![A-Za-z])BYPASSRLS/i.test(statement) ||
        /(?<![A-Za-z])SUPERUSER/i.test(statement) ||
        /\b(?:IN\s+ROLE|IN\s+GROUP|ROLE)\s+"?\w/i.test(statement.replace(ROLE_HEAD, ''))
      ) {
        problems.push(
          `${name}: platform_app must not be BYPASSRLS, SUPERUSER or a member of another role (${statement.trim()})`
        )
      }
    }
    for (const statement of text.match(WORKER_ALTER) ?? []) {
      if (/BYPASSRLS/i.test(statement)) {
        problems.push(
          `${name}: the bypass of platform_worker changes with pnpm db:rls:worker-role, not in a migration (${statement.trim()})`
        )
      } else if (
        /(?<![A-Za-z])SUPERUSER/i.test(statement) ||
        /\b(?:IN\s+ROLE|IN\s+GROUP|ROLE)\s+"?\w/i.test(statement.replace(WORKER_HEAD, ''))
      ) {
        problems.push(
          `${name}: platform_worker must not be SUPERUSER or a member of another role (${statement.trim()})`
        )
      }
    }
    for (const statement of text.match(WORKER_GRANT) ?? []) {
      problems.push(`${name}: a role must not be granted to platform_worker (${statement.trim()})`)
    }
    for (const statement of text.match(ROLE_GRANT) ?? []) {
      problems.push(`${name}: a role must not be granted to platform_app (${statement.trim()})`)
    }
    for (const statement of text.match(OWNER_TO) ?? []) {
      problems.push(`${name}: platform_app must not own a table (${statement.trim()})`)
    }
  }
  return problems
}
const ROLE_HEAD = /^\s*(?:ALTER|CREATE)\s+(?:ROLE|USER)\s+(?:IF\s+EXISTS\s+)?"?platform_app"?/i

// A session-level setting stays on a pooled PgBouncer connection and leaks into the next request (TDD_01 section 3.2): the only
// allowed form is set_config(name, value, true) inside a transaction, and SET LOCAL. The arguments of set_config are split at the
// top level, so a call such as set_config('app.x', lower(y), false) is read as it is written.
const SET_CONFIG = /\bset_config\s*\(/gi
const SESSION_SET = /\bSET\s+(?:SESSION\s+)?app\./i
function setConfigArguments(text: string, from: number): string[] {
  const args: string[] = []
  let depth = 1
  let current = ''
  let quote = ''
  for (let i = from; i < text.length && depth > 0; i += 1) {
    const ch = text[i] ?? ''
    if (quote !== '') {
      current += ch
      if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      current += ch
    } else if (ch === '(') {
      depth += 1
      current += ch
    } else if (ch === ')') {
      depth -= 1
      if (depth > 0) current += ch
    } else if (ch === ',' && depth === 1) {
      args.push(current.trim())
      current = ''
    } else current += ch
  }
  args.push(current.trim())
  return args
}
function hasSessionSetConfig(text: string): boolean {
  for (const match of text.matchAll(SET_CONFIG)) {
    const args = setConfigArguments(text, match.index + match[0].length)
    // Three arguments and the last one is not the literal true: a session-level setting (or one that cannot be told)
    if (args.length === 3 && args[2]?.toLowerCase() !== 'true') return true
  }
  return false
}
export function sessionSettingViolations(
  files: ReadonlyArray<{ path: string; text: string }>
): string[] {
  return files
    .filter(({ text }) => hasSessionSetConfig(text) || SESSION_SET.test(text))
    .map(
      ({ path }) =>
        `${path}: a session-level setting (set_config without a literal true, or SET) leaks through PgBouncer`
    )
}

// A policy of a scope that does not fit the columns of its table protects the wrong thing, or nothing: `store` on a table that
// has only organization_id never matches. Every rls_apply_policy call is checked against the schema.
const APPLY_SCOPE = /rls_apply_policy\(\s*'(\w+)'(?:::regclass)?\s*,\s*'(\w+)'/g
const SCOPES_OF: Readonly<Record<RlsScope, readonly string[]>> = {
  store: ['store', 'store_or_null'],
  organization: ['organization', 'organization_or_null'],
  both: ['store', 'organization', 'store_or_organization', 'store_or_null', 'organization_or_null'],
  none: []
}
export function scopeMismatches(
  tables: readonly RlsTable[],
  migrations: readonly MigrationSql[]
): string[] {
  const byTable = new Map(tables.map(table => [table.table, table]))
  const problems: string[] = []
  for (const { name, sql } of migrations) {
    for (const match of sql.replace(SQL_COMMENT, '').matchAll(APPLY_SCOPE)) {
      const table = byTable.get(match[1] ?? '')
      // A table that is not in the schema (the probe tables of the tests) is the business of orphanPolicies
      if (table === undefined) continue
      if (!SCOPES_OF[table.scope].includes(match[2] ?? '')) {
        problems.push(
          `${name}: ${table.table} has ${table.scope === 'none' ? 'no store_id or organization_id' : `scope ${table.scope}`} and gets the policy scope "${match[2]}"`
        )
      }
    }
  }
  return problems
}
