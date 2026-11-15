import { createRequire } from 'node:module'

import { Linter } from 'eslint'
import { parser } from 'typescript-eslint'

// The ban of eslint.config.js on writing the ledger outside libs/core/finance (TDD_18 §9.2), run as the linter runs it
const { financeWriteBans } = createRequire(__filename)('../../eslint-finance-bans.cjs') as {
  financeWriteBans: { selector: string; message: string }[]
}

const linter = new Linter({ configType: 'flat' })

function linesFlagged(code: string): number[] {
  const messages = linter.verify(
    code,
    [
      {
        files: ['**/*.ts'],
        languageOptions: { parser },
        rules: { 'no-restricted-syntax': ['error', ...financeWriteBans] }
      }
    ],
    'probe.ts'
  )
  return messages.map(message => message.line).sort((a, b) => a - b)
}

describe('the ban on writing the ledger outside the posting service', () => {
  it.each([
    ['a create of an entry', 'await tx.journalEntry.create({})'],
    ['a createMany of lines through the client', 'await prisma.client.journalLine.createMany({})'],
    ['an update of a balance', 'await tx.accountPeriodBalance.update({})'],
    ['a deleteMany', 'await tx.journalLine.deleteMany({ where: { id } })'],
    ['an upsert of a destructured model', 'await accountPeriodBalance.upsert({})'],
    ['createManyAndReturn', 'await tx.journalEntry.createManyAndReturn({})'],
    [
      'a template with an INSERT',
      'await tx.$executeRaw`INSERT INTO journal_entries (id) VALUES (1)`'
    ],
    [
      'a template with an UPDATE of the public schema',
      'await tx.$queryRaw`update public.account_period_balances set debit_cents = 0`'
    ],
    ['a quoted table in a string', 'await tx.$queryRawUnsafe(\'DELETE FROM "journal_lines"\')'],
    [
      'an INSERT INTO ONLY',
      'await tx.$executeRaw`INSERT INTO ONLY journal_entries (id) VALUES (1)`'
    ],
    ['a COPY', "await tx.$executeRawUnsafe('COPY journal_lines FROM STDIN')"],
    ['a TRUNCATE', "await tx.$executeRawUnsafe('TRUNCATE TABLE journal_entries')"]
  ])('refuses %s', (_label, statement) => {
    expect(linesFlagged(statement)).toEqual([1])
  })

  it.each([
    ['a read of an entry', 'await tx.journalEntry.findMany({})'],
    ['a count of lines', 'await tx.journalLine.count({})'],
    ['a write of another finance model', 'await tx.ledgerAccount.update({})'],
    ['a write of the settings', 'await tx.financeSettings.update({})'],
    ['a select in SQL', 'await tx.$queryRaw`SELECT * FROM journal_entries FOR UPDATE`'],
    [
      'a table whose name only starts the same',
      'await tx.$executeRaw`UPDATE journal_lines_archive SET a = 1`'
    ]
  ])('allows %s', (_label, statement) => {
    expect(linesFlagged(statement)).toEqual([])
  })
})
