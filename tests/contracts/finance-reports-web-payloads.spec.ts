import {
  journalCsvQuerySchema,
  ledgerCsvQuerySchema,
  ledgerQuerySchema,
  reopenPeriodSchema
} from '../../apps/api/src/modules/finance/finance-reports.schemas'
import {
  journalCsvInputOf,
  ledgerCsvInputOf,
  ledgerQueryOf,
  reopenInputOf,
  reopenReasonProblem,
  reportRangeProblem
} from '../../apps/web/lib/finance/report-form'

// What the forms of Finance → Reports and Periods send is what the api accepts (lesson of 4B.9a-1: a form that passes its own check and
// is refused by the api is a broken screen). Pure code: the schemas of the api and the helpers of the web, side by side.
const ACCOUNT = '0b9a6c1e-1111-4222-8333-444455556666'

const RANGES = [
  { from: '2026-01-01', to: '2026-01-01' },
  { from: '2026-01-01', to: '2026-12-31' },
  { from: '2024-01-01', to: '2024-12-31' },
  { from: '2025-01-01', to: '2026-01-01' },
  { from: '2025-01-01', to: '2026-01-02' },
  { from: '2026-02-30', to: '2026-03-01' },
  { from: '2026-03-02', to: '2026-03-01' },
  { from: ' 2026-01-01 ', to: '2026-01-31 ' }
]

describe('the files of Finance → Reports', () => {
  it.each(RANGES)('agrees with the api on the range $from – $to', range => {
    const draft = { from: range.from, to: range.to }
    const formSays = reportRangeProblem(draft, { bothEnds: true }) === null
    expect(journalCsvQuerySchema.safeParse(journalCsvInputOf(draft)).success).toBe(formSays)
    expect(ledgerCsvQuerySchema.safeParse(ledgerCsvInputOf(ACCOUNT, draft)).success).toBe(formSays)
  })

  it('sends a ledger query the api takes, with either end open', () => {
    for (const draft of [
      { from: '', to: '' },
      { from: '2026-01-01', to: '' },
      { from: '', to: '2026-01-31' },
      { from: '2026-01-01', to: '2026-01-31' }
    ]) {
      expect(reportRangeProblem(draft, { bothEnds: false })).toBeNull()
      const query = ledgerQueryOf(ACCOUNT, draft)
      // The page builds the query string of the api from the ends that are not null
      const search = Object.fromEntries(Object.entries(query).filter(([, value]) => value !== null))
      expect(ledgerQuerySchema.safeParse(search).success).toBe(true)
    }
  })
})

describe('the reopen of a month', () => {
  it.each([
    'a bill came late',
    '  padded  ',
    'x'.repeat(500),
    'x'.repeat(501),
    '',
    '   ',
    'a\nb',
    'a​b'
  ])('agrees with the api on the reason %j', reason => {
    const formSays = reopenReasonProblem(reason) === null
    expect(reopenPeriodSchema.safeParse(reopenInputOf(reason)).success).toBe(formSays)
  })
})
