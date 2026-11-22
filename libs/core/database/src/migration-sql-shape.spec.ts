import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations')

// Prisma sends a file of one statement without a transaction, which is the only way CONCURRENTLY works. A comment line that lost its
// `--` (a wrapped sentence) turns into SQL and fails the deploy with a syntax error (P3009), and nothing else runs the file before the CI
const CONCURRENT_STATEMENT =
  /^(CREATE|DROP) INDEX CONCURRENTLY( IF (NOT )?EXISTS)? "[a-z0-9_]+"( ON "[a-z0-9_]+"[^;]*)?;$/

function withoutComments(sql: string): string {
  return sql
    .split('\n')
    .filter(line => !/^\s*--/.test(line))
    .join('\n')
    .trim()
}

describe('migration files that build or drop an index concurrently', () => {
  const concurrent = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => ({
      name: entry.name,
      sql: readFileSync(join(MIGRATIONS, entry.name, 'migration.sql'), 'utf8')
    }))
    .filter(
      file =>
        /\bINDEX CONCURRENTLY\b/.test(withoutComments(file.sql)) ||
        /^\s*--.*\bINDEX CONCURRENTLY\b/m.test(file.sql)
    )

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
      expect(withoutComments(sql)).toMatch(CONCURRENT_STATEMENT)
    }
  )
})
