import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'

import { EntryRule } from './entry-rules'
import { entryProblemsError, financeRefusal, triggerRefusal } from './ledger-errors'

describe('entryProblemsError', () => {
  it('answers with the code of the first problem and every rule that broke, as a bad request', () => {
    const error = entryProblemsError([
      { code: ErrorCodes.FINANCE_ENTRY_UNBALANCED, rule: EntryRule.DEBITS_EQUAL_CREDITS },
      { code: ErrorCodes.VALIDATION_INVALID_INPUT, rule: EntryRule.MEMO_REQUIRED }
    ])

    expect(error.code).toBe(ErrorCodes.FINANCE_ENTRY_UNBALANCED)
    expect(error.statusCode).toBe(HttpStatusCodes.BAD_REQUEST)
    expect(error.metadata).toEqual({ rules: ['debits_equal_credits', 'memo_required'] })
  })
})

describe('financeRefusal', () => {
  it('is a conflict with the metadata the caller gives', () => {
    const error = financeRefusal(ErrorCodes.FINANCE_PERIOD_CLOSED, { period: '2026-1' })

    expect(error.statusCode).toBe(HttpStatusCodes.CONFLICT)
    expect(error.metadata).toEqual({ period: '2026-1' })
  })
})

describe('triggerRefusal', () => {
  const raised = (prefix: string): Error =>
    new Error(`Invalid prisma query: ${prefix}: details of the trigger`)

  it.each([
    ['FINANCE_PERIOD_CLOSED', ErrorCodes.FINANCE_PERIOD_CLOSED],
    ['FINANCE_BEFORE_START_DATE', ErrorCodes.FINANCE_BEFORE_START_DATE],
    ['FINANCE_ACCOUNT_NOT_POSTABLE', ErrorCodes.FINANCE_ACCOUNT_NOT_POSTABLE],
    ['FINANCE_ACCOUNT_INACTIVE', ErrorCodes.FINANCE_ACCOUNT_INACTIVE],
    ['FINANCE_SETUP_REQUIRED', ErrorCodes.FINANCE_SETUP_REQUIRED],
    ['FINANCE_ENTRY_UNBALANCED', ErrorCodes.FINANCE_ENTRY_UNBALANCED]
  ])('gives %s its typed answer', (prefix, code) => {
    expect(triggerRefusal(raised(prefix))?.code).toBe(code)
  })

  it('leaves the nets that are bugs or races of the service as the errors they are', () => {
    for (const prefix of [
      'FINANCE_ENTRY_NUMBER',
      'FINANCE_ENTRY_CHAIN',
      'FINANCE_ENTRY_PERIOD',
      'FINANCE_LEDGER_IMMUTABLE'
    ]) {
      expect(triggerRefusal(raised(prefix))).toBeNull()
    }
  })

  it('ignores an error that does not come from a finance trigger, and one that is an answer already', () => {
    expect(triggerRefusal(new Error('connection reset'))).toBeNull()
    expect(triggerRefusal('FINANCE_PERIOD_CLOSED: as a string, not an error')).toBeNull()
    expect(
      triggerRefusal(
        new PlatformException(
          ErrorCodes.FINANCE_PERIOD_CLOSED,
          'FINANCE_PERIOD_CLOSED: already typed'
        )
      )
    ).toBeNull()
  })

  it('takes the message of the database, the last, and not a memo the query echoed before it', () => {
    const echoed = new Error(
      'Invalid query with memo "x FINANCE_PERIOD_CLOSED: y" ... ERROR: FINANCE_ACCOUNT_INACTIVE: the account is inactive'
    )

    expect(triggerRefusal(echoed)?.code).toBe(ErrorCodes.FINANCE_ACCOUNT_INACTIVE)
  })

  it('does not take a word that only looks like a prefix', () => {
    expect(triggerRefusal(raised('NOT_FINANCE_PERIOD_CLOSED_AT_ALL'))).toBeNull()
  })
})
