import { AgingKind, LegalBookKind } from '@platform/core/domain'

import {
  bookQuerySchema,
  legalBookKindSchema
} from '../../apps/api/src/modules/finance/finance-books.schemas'
import {
  agingQuerySchema,
  balanceSheetQuerySchema,
  flowQuerySchema
} from '../../apps/api/src/modules/finance/finance-reports.schemas'
import {
  agingQueryOf,
  balanceSheetQueryOf,
  flowQueryOf,
  statementDayProblem,
  statementRangeProblem
} from '../../apps/web/lib/finance/statement-form'

// What the forms of Finance → Statements, Aging and Legal books send is what the api accepts (lesson of 4B.9a-1: a form that passes its
// own check and is refused by the api is a broken screen). Pure code: the schemas of the api and the helpers of the web, side by side.
const RANGES = [
  { from: '2026-01-01', to: '2026-01-01' },
  { from: '2026-01-01', to: '2026-12-31' },
  { from: '2020-01-01', to: '2026-12-31' },
  { from: '2026-02-30', to: '2026-03-01' },
  { from: '2026-03-02', to: '2026-03-01' },
  { from: '', to: '2026-03-01' },
  { from: ' 2026-01-01 ', to: '2026-01-31 ' }
]

const DAYS = [
  '2026-03-31',
  ' 2026-03-31 ',
  '2026-02-29',
  '2024-02-29',
  '',
  '31/03/2026',
  '2026-3-1'
]

describe('the statements of a range', () => {
  it.each(RANGES)('agrees with the api on the range "$from" – "$to"', range => {
    const formSays = statementRangeProblem(range) === null
    expect(flowQuerySchema.safeParse(flowQueryOf(range)).success).toBe(formSays)
  })
})

describe('the statements and lists of a day', () => {
  it.each(DAYS)('agrees with the api on the day "%s"', day => {
    const formSays = !statementDayProblem(day)
    expect(balanceSheetQuerySchema.safeParse(balanceSheetQueryOf(day)).success).toBe(formSays)
    for (const kind of Object.values(AgingKind)) {
      expect(agingQuerySchema.safeParse(agingQueryOf(kind, day)).success).toBe(formSays)
    }
  })
})

describe('the legal books', () => {
  it('asks for kinds and a month the api accepts', () => {
    for (const kind of Object.values(LegalBookKind)) {
      expect(legalBookKindSchema.safeParse(kind).success).toBe(true)
      expect(
        bookQuerySchema.safeParse({ periodId: '0b9a6c1e-1111-4222-8333-444455556666' }).success
      ).toBe(true)
    }
  })

  it('does not send a layout version: the book is read with the latest layout', () => {
    // The page names no version; a bare value must not read as the proposal (the api turns an empty one into none)
    expect(
      bookQuerySchema.safeParse({
        periodId: '0b9a6c1e-1111-4222-8333-444455556666',
        layoutVersion: ''
      }).success
    ).toBe(true)
  })
})
