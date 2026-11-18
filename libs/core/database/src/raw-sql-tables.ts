// The tables that a raw statement reads or writes, for the guard of PrismaService: a raw statement is not seen by the guard of the
// models, and on a table with a policy it answers no row (RLS fails closed) with nothing to say so. This does not parse SQL: it takes
// the name after FROM, JOIN, UPDATE, INTO and TRUNCATE (with the schema and the quotes that Prisma and our migrations write) and
// reports the ones that have a policy. A table that is named some other way (a list after a comma, a name built at run time) is not
// seen: the guard is a net for the common mistake, and the specs under the role of the worker are the proof.

// A name after one of these words is a table; after FROM and USING a list may follow (`FROM a, b`)
const TABLE_AFTER =
  /\b(from|using|join|update|into|merge\s+into|truncate(?:\s+table)?|lock(?:\s+table)?|copy)\s+(?:only\s+)?((?:"?\w+"?\.)?"?\w+"?(?:\s+(?:as\s+)?(?!(?:using|where|join|inner|left|right|full|cross|natural|on|set|group|order|limit|union|returning|for|having|window|offset|values|select)\b)"?\w+"?)?(?:\s*,\s*(?:"?\w+"?\.)?"?\w+"?(?:\s+(?:as\s+)?(?!(?:using|where|join|inner|left|right|full|cross|natural|on|set|group|order|limit|union|returning|for|having|window|offset|values|select)\b)"?\w+"?)?)*)/gi

// One pass that tracks the quotes: the text of a string and a comment become a space, and what looks like a comment inside a
// string (or a quote inside a comment) is not mistaken for one
function withoutNoise(sql: string): string {
  let out = ''
  let index = 0
  while (index < sql.length) {
    const ch = sql[index] ?? ''
    const next = sql[index + 1] ?? ''
    if (ch === "'") {
      index += 1
      while (index < sql.length) {
        if (sql[index] === "'" && sql[index + 1] === "'") index += 2
        else if (sql[index] === "'") break
        else index += 1
      }
      index += 1
      out += "''"
    } else if (ch === '-' && next === '-') {
      while (index < sql.length && sql[index] !== '\n') index += 1
      out += ' '
    } else if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', index + 2)
      index = end === -1 ? sql.length : end + 2
      out += ' '
    } else {
      out += ch
      index += 1
    }
  }
  return out
}

export function tablesOfRawSql(sql: string): string[] {
  const found = new Set<string>()
  for (const match of withoutNoise(sql).matchAll(TABLE_AFTER)) {
    // `a x, b y`: the first word of each item of the list is a table, the second is its alias
    for (const item of (match[2] ?? '').split(',')) {
      const name = item.trim().split(/\s+/)[0]
      const table = name?.split('.').at(-1)?.replaceAll('"', '')
      if (table !== undefined && table !== '') found.add(table.toLowerCase())
    }
  }
  return [...found]
}

// The lowered names of a list, made once per list: this runs on every raw statement that has no context
const lowered = new WeakMap<readonly string[], Set<string>>()

export function policyTablesOfRawSql(sql: string, policyTables: readonly string[]): string[] {
  let names = lowered.get(policyTables)
  if (names === undefined) {
    names = new Set(policyTables.map(table => table.toLowerCase()))
    lowered.set(policyTables, names)
  }
  const known = names
  return tablesOfRawSql(sql).filter(table => known.has(table))
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
