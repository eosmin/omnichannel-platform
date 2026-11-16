// The arithmetic of the reports (TDD_18 §10). Every amount is whole cents, kept as a bigint so a sum over the whole ledger cannot
// lose a cent to a float. A report only reads: nothing here touches the journal.

export interface DebitCredit {
  debitCents: bigint
  creditCents: bigint
}

export interface TrialBalanceTotals extends DebitCredit {
  // The debits equal the credits; false is an incident (TDD_18 §5.1, FINANCE_BALANCE_MISMATCHES)
  balanced: boolean
}

export function trialBalanceTotals(rows: readonly DebitCredit[]): TrialBalanceTotals {
  let debitCents = 0n
  let creditCents = 0n
  for (const row of rows) {
    debitCents += row.debitCents
    creditCents += row.creditCents
  }
  return { debitCents, creditCents, balanced: debitCents === creditCents }
}

// The balance of an account on the side where it normally sits: a positive number is where the account grows
export function normalBalance(row: DebitCredit, normalIsDebit: boolean): bigint {
  return normalIsDebit ? row.debitCents - row.creditCents : row.creditCents - row.debitCents
}

export interface LedgerLine extends DebitCredit {
  // Whatever identifies the line to the caller (its entry, its number): carried through untouched
  key: string
}

export interface RunningLine extends LedgerLine {
  // The balance after this line, on the normal side of the account
  runningCents: bigint
}

// The lines of one account in the order the caller read them, each with the balance after it. `openingCents` is what the account held
// before the first line (already on the normal side).
export function withRunningBalance(
  openingCents: bigint,
  lines: readonly LedgerLine[],
  normalIsDebit: boolean
): RunningLine[] {
  let running = openingCents
  return lines.map(line => {
    running += normalBalance(line, normalIsDebit)
    return { ...line, runningCents: running }
  })
}

// A period can be closed only once its last day is over, in the day the organization works in (TDD_18 §5.1 rule 4). `today` is the
// day of the clock the caller reads, never a date a person typed.
export const periodEnded = (endsOn: string, today: string): boolean => today > endsOn
