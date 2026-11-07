// The suites of the integration jobs run beside each other (the api and the worker at the same time) over one
// database and one bucket. A cleanup that deletes by a wide filter (a key pattern, a purpose, a status, or no
// filter at all) removes the rows another suite is in the middle of using: the avatars of the worker suite
// vanished under the `afterAll` of an api suite that did `DELETE FROM media WHERE key LIKE 'users/%/avatar/%'`.
// A cleanup deletes what its own suite made: by id, by owner, by store, or by the prefix of its own run.

// The first column of a `DELETE FROM <table> WHERE <column> ...` that names what a suite owns
const OWNED_COLUMNS = new Set([
  'id',
  'uploaded_by',
  'user_id',
  'store_id',
  'organization_id',
  'conversation_id',
  'message_id',
  'email',
  'slug',
  'event_id',
  'resource_type',
  'resource_id',
  'role_id'
])

export type WideDelete = { line: number; text: string; reason: string }

const lineOf = (source: string, index: number): number => source.slice(0, index).split('\n').length

export function findWideDeletes(source: string): WideDelete[] {
  const found: WideDelete[] = []
  // Upper case, as the suites write their SQL: the title of a case that says "delete from" is not a statement
  const sql =
    /DELETE\s+FROM\s+(\w+)(\s+WHERE\s+(\w+)(\s*(?:=|IN|LIKE)\s*(?:ANY\s*)?\(?\s*(?:SELECT\s+\w+\s+FROM\s+\w+\s+WHERE\s+\w+\s*(?:=|LIKE|IN)\s*)?(\$\d|\$\{))?)?/g
  for (const match of source.matchAll(sql)) {
    const column = match[3]?.toLowerCase()
    // The value comes from the suite (a bound parameter), never a literal or a predicate that matches every row
    const bound = match[5] !== undefined
    if (column !== undefined && OWNED_COLUMNS.has(column) && bound) continue
    found.push({
      line: lineOf(source, match.index),
      text: match[0].replace(/\s+/g, ' '),
      reason:
        column === undefined
          ? 'no WHERE: it deletes the table of everybody'
          : !OWNED_COLUMNS.has(column)
            ? `filters by "${column}", which is not what a suite owns`
            : `filters by "${column}" with a value that does not come from the suite`
    })
  }
  const prisma = /\.deleteMany\(\s*(\{\s*(where:\s*\{\s*\})?\s*\})?\s*\)/g
  for (const match of source.matchAll(prisma)) {
    found.push({
      line: lineOf(source, match.index),
      text: match[0].replace(/\s+/g, ' '),
      reason: 'deleteMany with no filter deletes the table of everybody'
    })
  }
  return found
}
