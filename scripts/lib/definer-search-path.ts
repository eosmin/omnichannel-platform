// A SECURITY DEFINER function runs with the privileges of its owner (the role of the migrations), so what it resolves by name must
// not be something a session of the application can plant. Postgres looks in pg_temp FIRST unless it is named in the search_path,
// and every role of the application may create temporary tables: a temp table called like the table of the function would be read
// instead of the real one. The rule, for every migration:
//   1. a SECURITY DEFINER function says `SET search_path = ...` in its own header (a setting of the caller's session is never trusted);
//   2. pg_temp is the LAST element of that list (public, pg_catalog or nothing before it);
//   3. when `public` is not in the list, the tables of the body are named with their schema (`public.audit_logs`);
//   4. a function is never made SECURITY DEFINER afterwards (ALTER FUNCTION ... SECURITY DEFINER): its header is the place to read it.
// Pure functions of scripts/check-definer-search-path.ts.

export interface MigrationSql {
  name: string
  sql: string
}

const COMMENT = /--.*$/gm
// The header of a function ends where its body begins (`AS $$` or `AS $tag$`)
const FUNCTION_START = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w."]+)\s*\(/gi
const BODY_START = /\bAS\s+(\$\w*\$|')/i
const ALTER_DEFINER = /ALTER\s+FUNCTION\s+[^;]*\bSECURITY\s+DEFINER\b/gi
// `SELECT ... INTO variable` assigns a PL/pgSQL variable and `IS DISTINCT FROM x` compares: neither names a table
// `FROM unnest(...)` is a function, and `INSERT INTO t (a, b)` is a table with its columns: only the first is skipped for a `(`
const TABLE_REFERENCE =
  /(?<!DISTINCT\s+)\b(?:FROM|JOIN|UPDATE|TRUNCATE(?:\s+TABLE)?)\s+(?:ONLY\s+)?"?([a-z_][a-z0-9_]*)(?![a-z0-9_"]|"?\s*\.|"?\s*\()/gi
const INSERT_REFERENCE = /\bINSERT\s+INTO\s+"?([a-z_][a-z0-9_]*)(?![a-z0-9_"]|"?\s*\.)/gi
// Words that follow these keywords without being a table
const NOT_A_TABLE = new Set([
  'select',
  'set',
  'values',
  'lateral',
  'unnest',
  'only',
  'table',
  'the',
  'each',
  'row'
])

function searchPathOf(header: string): string[] | undefined {
  const match =
    /\bSET\s+search_path\s*(?:=|TO)\s*([^\n]*?)(?=\s+(?:AS|SET|LANGUAGE|SECURITY|STABLE|VOLATILE|IMMUTABLE|PARALLEL|COST|RETURNS|LEAKPROOF)\b|\s*$)/im.exec(
      header
    )
  if (match === null) return undefined
  return (match[1] ?? '')
    .split(',')
    .map(part => part.trim().replace(/^'|'$/g, '').toLowerCase())
    .filter(part => part !== '')
}

// The tables a body names with no schema, leaving out the names of its own WITH queries
function unqualifiedTables(body: string): string[] {
  const own = new Set(
    [...body.matchAll(/\b([a-z_][a-z0-9_]*)\s+AS\s*\(/gi)].map(m => (m[1] ?? '').toLowerCase())
  )
  const found = new Set<string>()
  for (const m of [...body.matchAll(TABLE_REFERENCE), ...body.matchAll(INSERT_REFERENCE)]) {
    const name = (m[1] ?? '').toLowerCase()
    if (!NOT_A_TABLE.has(name) && !own.has(name)) found.add(name)
  }
  return [...found].sort()
}

export function definerViolations(migrations: readonly MigrationSql[]): string[] {
  const problems: string[] = []
  for (const { name, sql } of migrations) {
    const text = sql.replace(COMMENT, '')
    let readHeaders = 0
    for (const m of text.matchAll(FUNCTION_START)) {
      const rest = text.slice(m.index)
      const bodyAt = BODY_START.exec(rest)
      // A header with no `AS $$` or `AS '` (a `RETURN` or `BEGIN ATOMIC` body) ends with its statement
      const header = rest.slice(0, bodyAt === null ? Math.max(rest.indexOf(';'), 0) : bodyAt.index)
      readHeaders += (header.match(/\bSECURITY\s+DEFINER\b/gi) ?? []).length
      if (!/\bSECURITY\s+DEFINER\b/i.test(header)) continue
      const fn = (m[1] ?? '').replaceAll('"', '')
      const path = searchPathOf(header)
      if (path === undefined) {
        problems.push(`${name}: ${fn} is SECURITY DEFINER with no SET search_path in its header`)
        continue
      }
      if (path[path.length - 1] !== 'pg_temp') {
        problems.push(
          `${name}: ${fn} has search_path = ${path.join(', ')}: pg_temp must be the last element (a temp table would shadow the tables)`
        )
        continue
      }
      if (!path.includes('public') && bodyAt !== null) {
        const delimiter = bodyAt[1] ?? '$$'
        const start = rest.indexOf(delimiter, bodyAt.index) + delimiter.length
        const end = rest.indexOf(delimiter, start)
        const body = rest.slice(start, end === -1 ? undefined : end)
        const loose = unqualifiedTables(body)
        if (loose.length > 0) {
          problems.push(
            `${name}: ${fn} has no public in its search_path, so name the schema of: ${loose.join(', ')}`
          )
        }
      }
    }
    // Fail closed: a SECURITY DEFINER that no header above accounts for (dynamic SQL in a DO block, a statement the patterns do not
    // read) is refused, because the checker cannot tell whether it is safe
    const mentions = (text.match(/\bSECURITY\s+DEFINER\b/gi) ?? []).length
    const altered = (text.match(ALTER_DEFINER) ?? []).length
    if (mentions > readHeaders + altered) {
      problems.push(
        `${name}: a SECURITY DEFINER that this check could not read (dynamic SQL or an unusual statement): write it as a plain CREATE FUNCTION`
      )
    }
    for (const alter of text.match(ALTER_DEFINER) ?? []) {
      problems.push(
        `${name}: a function is made SECURITY DEFINER after it was created (${alter.trim().slice(0, 80)}): say it in CREATE FUNCTION, with its search_path`
      )
    }
  }
  return problems
}
