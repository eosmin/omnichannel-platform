import { listFiscalDocumentsQuerySchema } from '@platform/core/domain'

import { periodFiltersOf, periodProblem, PeriodProblems } from './period-filter'

describe('the period of the list of fiscal documents', () => {
  it('has no problem with no day, with one day or with a good range', () => {
    expect(periodProblem({ from: '', to: '' })).toBeNull()
    expect(periodProblem({ from: '2026-11-01', to: '' })).toBeNull()
    expect(periodProblem({ from: '', to: '2026-11-30' })).toBeNull()
    expect(periodProblem({ from: '2026-11-30', to: '2026-11-30' })).toBeNull()
  })

  it.each([
    [{ from: '2026-02-30', to: '' }, PeriodProblems.FROM],
    [{ from: '', to: 'tomorrow' }, PeriodProblems.TO],
    [{ from: '2026-12-01', to: '2026-11-30' }, PeriodProblems.ORDER]
  ])('says what is wrong with %j', (draft, problem) => {
    expect(periodProblem(draft)).toBe(problem)
  })

  it('asks for the whole of the first and of the last day, in the zone of the person', () => {
    const asked = periodFiltersOf({ from: '2026-11-01', to: '2026-11-30' })

    expect(asked.from).toBe(new Date(2026, 10, 1, 0, 0, 0, 0).toISOString())
    expect(asked.to).toBe(new Date(2026, 10, 30, 23, 59, 59, 999).toISOString())
  })

  it('leaves out an end that is empty, so it is not a filter', () => {
    expect(periodFiltersOf({ from: '', to: '' })).toEqual({})
    expect(periodFiltersOf({ from: '2026-11-01', to: '' })).toEqual({
      from: new Date(2026, 10, 1).toISOString()
    })
  })

  it('writes a question the schema of the api reads', () => {
    const parsed = listFiscalDocumentsQuerySchema.safeParse(
      periodFiltersOf({ from: '2026-11-01', to: '2026-11-30' })
    )

    expect(parsed.success).toBe(true)
  })
})
