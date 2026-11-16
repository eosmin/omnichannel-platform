import { AgingKind } from '@platform/core/domain'

import {
  agingQueryOf,
  balanceSheetQueryOf,
  dayFileName,
  defaultRange,
  flowFileName,
  flowQueryOf,
  statementDayProblem,
  statementRangeProblem
} from './statement-form'

describe('the range of a statement', () => {
  it('accepts a range of one day and a long one (a statement is a sum, not a file of rows)', () => {
    expect(statementRangeProblem({ from: '2026-03-01', to: '2026-03-01' })).toBeNull()
    expect(statementRangeProblem({ from: '2020-01-01', to: '2026-12-31' })).toBeNull()
  })

  it('names the end that is wrong', () => {
    expect(statementRangeProblem({ from: '', to: '2026-03-01' })).toBe('from')
    expect(statementRangeProblem({ from: '2026-02-30', to: '2026-03-01' })).toBe('from')
    expect(statementRangeProblem({ from: '2026-03-01', to: '2026-13-01' })).toBe('to')
    expect(statementRangeProblem({ from: '2026-03-02', to: '2026-03-01' })).toBe('order')
  })

  it('trims what the person typed before it is sent', () => {
    expect(flowQueryOf({ from: ' 2026-03-01 ', to: '2026-03-31\n' })).toEqual({
      from: '2026-03-01',
      to: '2026-03-31'
    })
    expect(balanceSheetQueryOf(' 2026-03-31 ')).toEqual({ asOf: '2026-03-31' })
    expect(agingQueryOf(AgingKind.PAYABLES, ' 2026-03-31 ')).toEqual({
      kind: 'payables',
      asOf: '2026-03-31'
    })
  })
})

describe('the day of a statement', () => {
  it('is a real day of the calendar', () => {
    expect(statementDayProblem('2026-03-31')).toBe(false)
    expect(statementDayProblem(' 2026-03-31 ')).toBe(false)
    expect(statementDayProblem('2026-02-29')).toBe(true)
    expect(statementDayProblem('')).toBe(true)
    expect(statementDayProblem('31/03/2026')).toBe(true)
  })
})

describe('what a statement starts from', () => {
  it('is the month so far, in the day of the clock', () => {
    expect(defaultRange(new Date(2026, 2, 17, 10, 0, 0))).toEqual({
      from: '2026-03-01',
      to: '2026-03-17'
    })
  })
})

describe('the names of the files', () => {
  it('say the report and the question that was asked', () => {
    expect(flowFileName('cash-flow', { from: '2026-03-01', to: '2026-03-31' })).toBe(
      'cash-flow-2026-03-01-2026-03-31.csv'
    )
    expect(dayFileName('receivables-aging', '2026-03-31')).toBe('receivables-aging-2026-03-31.csv')
  })
})
