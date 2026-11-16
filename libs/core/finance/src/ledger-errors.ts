import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'

import type { EntryProblem } from './entry-rules'

// What the posting service answers when it refuses (TDD_18 §4.1). The messages are English and go to the logs; the client
// reads the code and the metadata.

type Refusal =
  | typeof ErrorCodes.FINANCE_PERIOD_CLOSED
  | typeof ErrorCodes.FINANCE_BEFORE_START_DATE
  | typeof ErrorCodes.FINANCE_ACCOUNT_NOT_POSTABLE
  | typeof ErrorCodes.FINANCE_ACCOUNT_INACTIVE
  | typeof ErrorCodes.FINANCE_ENTRY_ALREADY_REVERSED
  | typeof ErrorCodes.FINANCE_ENTRY_RECONCILED
  | typeof ErrorCodes.FINANCE_SETUP_REQUIRED
  | typeof ErrorCodes.FINANCE_CLOSE_PENDING_POSTINGS
  | typeof ErrorCodes.FINANCE_CLOSE_PREVIOUS_OPEN
  | typeof ErrorCodes.FINANCE_CLOSE_NOT_ENDED
  | typeof ErrorCodes.FINANCE_BALANCE_MISMATCHES
  | typeof ErrorCodes.FINANCE_PERIOD_NOT_CLOSED
  | typeof ErrorCodes.FINANCE_PERIOD_ALREADY_CLOSED
  | typeof ErrorCodes.FINANCE_REOPEN_NOT_LATEST

const MESSAGES: Record<Refusal, string> = {
  [ErrorCodes.FINANCE_PERIOD_CLOSED]: 'the period of the entry is closed',
  [ErrorCodes.FINANCE_BEFORE_START_DATE]: 'the date is before the accounting start date',
  [ErrorCodes.FINANCE_ACCOUNT_NOT_POSTABLE]: 'the account takes no entries',
  [ErrorCodes.FINANCE_ACCOUNT_INACTIVE]: 'the account is inactive',
  [ErrorCodes.FINANCE_ENTRY_ALREADY_REVERSED]: 'the entry was reversed already',
  [ErrorCodes.FINANCE_ENTRY_RECONCILED]:
    'the entry is reconciled with a bank statement: take the match back first',
  [ErrorCodes.FINANCE_SETUP_REQUIRED]: 'the organization has no finance settings yet',
  [ErrorCodes.FINANCE_CLOSE_PENDING_POSTINGS]:
    'a posting is pending or failed: resolve it before closing',
  [ErrorCodes.FINANCE_CLOSE_PREVIOUS_OPEN]:
    'the previous period is still open: closes are in order',
  [ErrorCodes.FINANCE_CLOSE_NOT_ENDED]: 'the period has not ended yet',
  [ErrorCodes.FINANCE_BALANCE_MISMATCHES]: 'the balances of the period do not match the journal',
  [ErrorCodes.FINANCE_PERIOD_NOT_CLOSED]: 'the period is not closed',
  [ErrorCodes.FINANCE_PERIOD_ALREADY_CLOSED]: 'the period is closed already',
  [ErrorCodes.FINANCE_REOPEN_NOT_LATEST]: 'only the latest closed period can be reopened'
}

export const financeRefusal = (
  code: Refusal,
  metadata?: Record<string, unknown>
): PlatformException =>
  new PlatformException(code, MESSAGES[code], HttpStatusCodes.CONFLICT, metadata)

// The rules an entry broke before it reached the database: every one is reported, the first decides the code
export function entryProblemsError(problems: readonly EntryProblem[]): PlatformException {
  const [first] = problems
  return new PlatformException(
    first?.code ?? ErrorCodes.VALIDATION_INVALID_INPUT,
    'the entry breaks the rules of a journal entry',
    HttpStatusCodes.BAD_REQUEST,
    { rules: problems.map(problem => problem.rule) }
  )
}

// The rules the triggers of the database keep (TDD_18 §2.5), by the prefix of the message they raise. They are the net
// under the checks of the service, so one that fires is a race or a bug: the ones a person can cause by timing (a close in
// flight, an account switched off a moment ago) get their typed answer, the rest (the number, the chain, the period of
// the date) are not mapped and surface as the error they are.
const TRIGGER_REFUSALS: readonly Refusal[] = [
  ErrorCodes.FINANCE_PERIOD_CLOSED,
  ErrorCodes.FINANCE_BEFORE_START_DATE,
  ErrorCodes.FINANCE_ACCOUNT_NOT_POSTABLE,
  ErrorCodes.FINANCE_ACCOUNT_INACTIVE,
  ErrorCodes.FINANCE_ENTRY_RECONCILED,
  ErrorCodes.FINANCE_SETUP_REQUIRED
]
const TRIGGER_PREFIX = /\b(FINANCE_[A-Z_]+):/g

// Prisma hides the SQLSTATE of a trigger but keeps its message, after the query it echoes (and the query carries what a person
// typed, a memo that says "FINANCE_PERIOD_CLOSED:" for one). So the message of the database is the LAST prefix, never the first.
export function triggerRefusal(error: unknown): PlatformException | null {
  if (error instanceof PlatformException) return null
  const message = error instanceof Error ? error.message : ''
  const prefix = [...message.matchAll(TRIGGER_PREFIX)].at(-1)?.[1]
  if (prefix === undefined) return null
  if (prefix === ErrorCodes.FINANCE_ENTRY_UNBALANCED) {
    return new PlatformException(
      ErrorCodes.FINANCE_ENTRY_UNBALANCED,
      'the database refused an entry that does not balance',
      HttpStatusCodes.BAD_REQUEST
    )
  }
  const code = TRIGGER_REFUSALS.find(known => known === prefix)
  return code === undefined ? null : financeRefusal(code)
}
