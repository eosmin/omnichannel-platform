import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations')

// Prisma sends this file without a transaction only if it is ONE statement, and CONCURRENTLY needs that. A comment line that lost its
// `--` (a wrapped sentence) turns into SQL and fails the deploy with a syntax error (P3009), and nothing else runs the file before the CI.
// Case-insensitive, so `create index concurrently a; select 1;` does not escape the check by being written in lower case.
// Limit, on purpose (Step 7.3-S14 debt): it covers CREATE and DROP INDEX CONCURRENTLY with a double-quoted name and no schema; any other
// form (REINDEX ... CONCURRENTLY, DETACH PARTITION ... CONCURRENTLY, a schema-qualified name) is not detected, and a file that has the
// phrase `INDEX CONCURRENTLY` outside a comment and does not fit this shape fails the check (the safe side)
const CONCURRENT_STATEMENT =
  /^(CREATE|DROP) INDEX CONCURRENTLY( IF (NOT )?EXISTS)? "[a-z0-9_]+"( ON "[a-z0-9_]+"[^;]*)?;$/i

function withoutComments(sql: string): string {
  return sql
    .split('\n')
    .filter(line => !/^\s*--/.test(line))
    .join('\n')
    .trim()
}

// Only the lines that are not `--` comments: a migration that names the phrase in its comments next to other statements is not one
function mentionsConcurrentIndex(sql: string): boolean {
  return /\bINDEX CONCURRENTLY\b/i.test(withoutComments(sql))
}

function isOneConcurrentStatement(sql: string): boolean {
  return CONCURRENT_STATEMENT.test(withoutComments(sql))
}

describe('the check of a concurrent index migration', () => {
  it('accepts one statement under comments', () => {
    expect(isOneConcurrentStatement('-- a\n-- b\nDROP INDEX CONCURRENTLY IF EXISTS "i";\n')).toBe(
      true
    )
  })

  it('rejects a comment line that lost its marker', () => {
    expect(
      isOneConcurrentStatement(
        '-- a\nDROP INDEX CONCURRENTLY cannot run\nDROP INDEX CONCURRENTLY IF EXISTS "i";'
      )
    ).toBe(false)
  })

  it('rejects a second statement, also in lower case', () => {
    expect(isOneConcurrentStatement('create index concurrently "i" on "t" ("c"); select 1;')).toBe(
      false
    )
    expect(isOneConcurrentStatement('DROP INDEX CONCURRENTLY "i";\nANALYZE "t";')).toBe(false)
  })

  it('finds a lower case statement, and ignores a phrase that is only in a comment', () => {
    expect(mentionsConcurrentIndex('create index concurrently "i" on "t" ("c");')).toBe(true)
    expect(
      mentionsConcurrentIndex('-- see INDEX CONCURRENTLY\nALTER TABLE "t" DROP COLUMN "c";')
    ).toBe(false)
  })
})

describe('migration files that build or drop an index concurrently', () => {
  const concurrent = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => ({
      name: entry.name,
      sql: readFileSync(join(MIGRATIONS, entry.name, 'migration.sql'), 'utf8')
    }))
    .filter(file => mentionsConcurrentIndex(file.sql))

  it('finds the ones that exist', () => {
    expect(concurrent.map(file => file.name)).toEqual(
      expect.arrayContaining([
        '20270125400000_channel_connections_list_index',
        '20270127500000_drop_messages_search_index'
      ])
    )
  })

  it.each(concurrent.map(file => [file.name, file.sql]))(
    '%s is exactly one statement, every other line a `--` comment',
    (_name, sql) => {
      expect(isOneConcurrentStatement(sql)).toBe(true)
    }
  )
})
