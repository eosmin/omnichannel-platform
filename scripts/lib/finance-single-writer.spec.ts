import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// The journal has one writer (TDD_18 §9.2): LedgerService of libs/core/finance. The lint rule sees a call it can name; this reads
// the sources themselves, so a write the rule cannot see (a nested relation write through the period or the account, which the
// triggers of the database refuse anyway) is found too, and so is any other file that writes the ledger tables directly. The
// specs and the builders of the suites write as the owner of a database, and are not application code.

const ROOT = join(__dirname, '..', '..')
const SKIPPED = new Set(['node_modules', 'generated', 'dist', '.nx', '.next', 'coverage', '.git'])
const WRITER = 'libs/core/finance/src/ledger.service.ts'

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    if (SKIPPED.has(name)) return []
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx?$/.test(path) ? [path] : []
  })
}

const isApplicationCode = (path: string): boolean =>
  !/\.spec\.tsx?$/.test(path) &&
  !/(^|\/)tests\//.test(path) &&
  !/(^|\/)src\/testing\//.test(path) &&
  !/(^|\/)web-e2e\//.test(path)

const TABLES = '(journalEntry|journalLine|accountPeriodBalance)'
const WRITES =
  '(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)'
const DIRECT = new RegExp(`\\b${TABLES}\\s*\\.\\s*${WRITES}\\b`)
const SQL =
  /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(\s+TABLE)?|COPY)\s+(ONLY\s+)?"?(public"?\.)?"?(journal_entries|journal_lines|account_period_balances)\b/i
// `fiscalPeriod.update({ data: { entries: { create: ... } } })`: a write of a line or an entry through its parent
const NESTED =
  /\b(entries|lines|balances)\s*:\s*\{\s*(create|createMany|connectOrCreate|update|updateMany|upsert|delete|deleteMany|set)\b/
const MENTIONS_LEDGER = /\b(fiscalPeriod|ledgerAccount|journalEntry|journalLine)\b/

describe('the single writer of the journal', () => {
  const application = sources(ROOT)
    .map(path => relative(ROOT, path))
    .filter(isApplicationCode)

  it('finds the application code it is meant to read', () => {
    expect(application).toContain(WRITER)
    expect(application.length).toBeGreaterThan(500)
  })

  it('is the only application file that writes the ledger tables', () => {
    const writers = application.filter(path => {
      const text = readFileSync(join(ROOT, path), 'utf8')
      return DIRECT.test(text) || SQL.test(text)
    })

    expect(writers).toEqual([WRITER])
  })

  it('has no application file that writes an entry, a line or a balance through a parent', () => {
    const nested = application.filter(path => {
      const text = readFileSync(join(ROOT, path), 'utf8')
      return MENTIONS_LEDGER.test(text) && NESTED.test(text)
    })

    expect(nested).toEqual([])
  })

  it('reads the patterns it looks for', () => {
    expect(DIRECT.test('await tx.journalEntry.create({})')).toBe(true)
    expect(DIRECT.test('await tx.journalLine.createMany({})')).toBe(true)
    expect(DIRECT.test('await tx.journalEntry.findMany({})')).toBe(false)
    expect(SQL.test('INSERT INTO journal_lines (id) VALUES (1)')).toBe(true)
    expect(SQL.test('SELECT * FROM journal_lines')).toBe(false)
    expect(NESTED.test('fiscalPeriod.update({ data: { entries: { create: {} } } })')).toBe(true)
  })
})
