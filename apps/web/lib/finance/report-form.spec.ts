import {
  closePhraseMatches,
  closePhraseOf,
  journalCsvInputOf,
  journalFileName,
  ledgerCsvInputOf,
  ledgerFileName,
  ledgerQueryOf,
  reopenInputOf,
  reopenReasonProblem,
  ReopenReasonProblems,
  ReportRangeProblems,
  reportRangeProblem,
  trialBalanceFileName
} from './report-form'

describe('reportRangeProblem', () => {
  it('accepts a range with both ends, on one day or on a leap year', () => {
    expect(
      reportRangeProblem({ from: '2026-01-01', to: '2026-01-01' }, { bothEnds: true })
    ).toBeNull()
    expect(
      reportRangeProblem({ from: '2024-01-01', to: '2024-12-31' }, { bothEnds: true })
    ).toBeNull()
  })

  it('refuses a day that does not exist, and says which end', () => {
    expect(reportRangeProblem({ from: '2026-02-30', to: '2026-03-01' }, { bothEnds: true })).toBe(
      ReportRangeProblems.FROM
    )
    expect(reportRangeProblem({ from: '2026-02-01', to: '2026-13-01' }, { bothEnds: true })).toBe(
      ReportRangeProblems.TO
    )
  })

  it('refuses a first day after the last one', () => {
    expect(reportRangeProblem({ from: '2026-03-02', to: '2026-03-01' }, { bothEnds: false })).toBe(
      ReportRangeProblems.ORDER
    )
  })

  it('refuses a file range of 366 days or more, and lets the screen ledger be as long as it likes', () => {
    // 2025-01-01 to 2026-01-01 is 365 days apart: the api accepts it (less than 366)
    expect(
      reportRangeProblem({ from: '2025-01-01', to: '2026-01-01' }, { bothEnds: true })
    ).toBeNull()
    expect(reportRangeProblem({ from: '2025-01-01', to: '2026-01-02' }, { bothEnds: true })).toBe(
      ReportRangeProblems.LENGTH
    )
    expect(
      reportRangeProblem({ from: '2000-01-01', to: '2026-01-02' }, { bothEnds: false })
    ).toBeNull()
  })

  it('needs both ends of a file and neither end of the ledger', () => {
    expect(reportRangeProblem({ from: '', to: '2026-01-01' }, { bothEnds: true })).toBe(
      ReportRangeProblems.FROM
    )
    expect(reportRangeProblem({ from: '2026-01-01', to: '' }, { bothEnds: true })).toBe(
      ReportRangeProblems.TO
    )
    expect(reportRangeProblem({ from: '', to: '' }, { bothEnds: false })).toBeNull()
  })
})

describe('what the forms send', () => {
  it('trims the days of a file', () => {
    expect(journalCsvInputOf({ from: ' 2026-01-01 ', to: '2026-01-31 ' })).toEqual({
      from: '2026-01-01',
      to: '2026-01-31'
    })
    expect(ledgerCsvInputOf('a1', { from: '2026-01-01', to: '2026-01-31' })).toEqual({
      accountId: 'a1',
      from: '2026-01-01',
      to: '2026-01-31'
    })
  })

  it('leaves an open end of the ledger out', () => {
    expect(ledgerQueryOf('a1', { from: '', to: '2026-01-31' })).toEqual({
      accountId: 'a1',
      from: null,
      to: '2026-01-31'
    })
  })

  it('names the files as the api does', () => {
    expect(trialBalanceFileName({ year: 2026, month: 3 })).toBe('trial-balance-2026-03.csv')
    expect(ledgerFileName('1101', { from: '2026-01-01', to: '2026-01-31' })).toBe(
      'ledger-1101-2026-01-01-2026-01-31.csv'
    )
    expect(journalFileName({ from: '2026-01-01', to: '2026-01-31' })).toBe(
      'journal-2026-01-01-2026-01-31.csv'
    )
  })
})

describe('reopenReasonProblem', () => {
  it('asks for a reason', () => {
    expect(reopenReasonProblem('')).toBe(ReopenReasonProblems.EMPTY)
    expect(reopenReasonProblem('   ')).toBe(ReopenReasonProblems.EMPTY)
    expect(reopenReasonProblem('a bill came late')).toBeNull()
  })

  it('refuses a reason over the limit, counted after the trim', () => {
    expect(reopenReasonProblem('x'.repeat(500))).toBeNull()
    expect(reopenReasonProblem(` ${'x'.repeat(500)} `)).toBeNull()
    expect(reopenReasonProblem('x'.repeat(501))).toBe(ReopenReasonProblems.TOO_LONG)
  })

  it('refuses a line break and an invisible character, as the api does', () => {
    expect(reopenReasonProblem('one\ntwo')).toBe(ReopenReasonProblems.INVALID)
    expect(reopenReasonProblem('a​b')).toBe(ReopenReasonProblems.INVALID)
  })

  it('sends the trimmed reason', () => {
    expect(reopenInputOf('  late bill  ')).toEqual({ reason: 'late bill' })
  })
})

describe('the phrase that closes a month', () => {
  it('is the month as YYYY-MM, and is read without the spaces around it but not by another case or month', () => {
    const period = { year: 2026, month: 3 }
    expect(closePhraseOf(period)).toBe('2026-03')
    expect(closePhraseMatches(' 2026-03 ', period)).toBe(true)
    expect(closePhraseMatches('2026-3', period)).toBe(false)
    expect(closePhraseMatches('2026-04', period)).toBe(false)
    expect(closePhraseMatches('', period)).toBe(false)
  })
})
