// The tables that a raw statement reads or writes, for the guard of PrismaService: a raw statement is not seen by the guard of the
// models, and on a table with a policy it answers no row (RLS fails closed) with nothing to say so. This does not parse SQL: it takes
// the name after FROM, JOIN, UPDATE, INTO and TRUNCATE (with the schema and the quotes that Prisma and our migrations write) and
// reports the ones that have a policy. A table that is named some other way (a list after a comma, a name built at run time) is not
// seen: the guard is a net for the common mistake, and the specs under the role of the worker are the proof.

const TABLE_AFTER =
  /\b(?:from|join|update|into|truncate(?:\s+table)?)\s+(?:only\s+)?((?:"?\w+"?\.)?"?\w+"?)/gi

function withoutNoise(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
}

export function tablesOfRawSql(sql: string): string[] {
  const found = new Set<string>()
  for (const match of withoutNoise(sql).matchAll(TABLE_AFTER)) {
    const name = match[1]
    if (name === undefined) continue
    const table = name.split('.').at(-1)?.replaceAll('"', '')
    if (table !== undefined && table !== '') found.add(table.toLowerCase())
  }
  return [...found]
}

export function policyTablesOfRawSql(sql: string, policyTables: readonly string[]): string[] {
  const lower = new Set(policyTables.map(table => table.toLowerCase()))
  return tablesOfRawSql(sql).filter(table => lower.has(table))
}

// The text of the arguments that Prisma hands to the guard of a raw statement: the tagged template of $queryRaw / $executeRaw is
// `{ strings, values }` (a value can itself be a Prisma.sql fragment, with its own strings), and the Unsafe forms take the text first
export function sqlTextOfRawArgs(args: unknown): string {
  if (Array.isArray(args)) return typeof args[0] === 'string' ? args[0] : ''
  if (typeof args !== 'object' || args === null) return ''
  const { strings, values } = args as { strings?: unknown; values?: unknown }
  const text = Array.isArray(strings)
    ? strings.filter(part => typeof part === 'string').join(' ')
    : ''
  const nested = Array.isArray(values) ? values.map(value => sqlTextOfRawArgs(value)) : []
  return [text, ...nested].join(' ')
}
