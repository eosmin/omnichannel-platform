import {
  JOURNAL_CSV_COLUMNS,
  type JournalCsvRow,
  journalCsvHeader,
  journalCsvRows,
  LEDGER_CSV_COLUMNS,
  ledgerCsv,
  trialBalanceCsv
} from './finance-reports.csv'

const row = (extra: Partial<JournalCsvRow> = {}): JournalCsvRow => ({
  number: 1,
  entryId: 'entry-1',
  entryDate: '2026-01-15',
  periodId: 'period-1',
  type: 'manual',
  sourceType: null,
  sourceId: null,
  sourceDate: null,
  reversesEntryId: null,
  idempotencyKey: 'manual:k1',
  entryMemo: 'Rent',
  currency: 'USD',
  totalCents: 1000,
  origin: 'user',
  createdBy: 'user-1',
  prevHash: null,
  hash: 'abc123',
  lineNo: 1,
  accountId: 'account-1',
  accountCode: '6105',
  accountName: 'Alquileres',
  debitCents: 1000,
  creditCents: 0,
  storeId: null,
  partyType: null,
  partyId: null,
  taxRateId: null,
  lineMemo: null,
  ...extra
})

describe('the CSV of the journal', () => {
  it('has a column for each value of a row, in the order the rows are written', () => {
    const header = journalCsvHeader()
      .replace(/^\uFEFF/, '')
      .trim()
      .split(',')
    const written = journalCsvRows([row()]).trim().split(',')

    expect(header).toEqual([...JOURNAL_CSV_COLUMNS])
    expect(written).toHaveLength(JOURNAL_CSV_COLUMNS.length)
  })

  it('writes a missing value as an empty cell and an amount as a number', () => {
    const [cells] = journalCsvRows([row()]).split('\r\n')

    expect(cells).toContain(',,,,')
    expect(cells).toContain(',1000,0,')
  })

  it('starts a text that looks like a formula with a quote, in every text column', () => {
    const text = journalCsvRows([
      row({ entryMemo: '=1+1', lineMemo: '@SUM(A1)', accountName: '+cmd', partyId: '-2+3' })
    ])

    expect(text).toContain("'=1+1")
    expect(text).toContain("'@SUM(A1)")
    expect(text).toContain("'+cmd")
    expect(text).toContain("'-2+3")
  })

  it('gives a memo that is a formula and one that starts with a quote and a formula two different cells (LED-R2-010)', () => {
    const cellsOf = (memo: string): string[] =>
      (journalCsvRows([row({ entryMemo: memo })]).split('\r\n')[0] ?? '').split(',')

    expect(cellsOf('=1+1')).toContain("'=1+1")
    expect(cellsOf("'=1+1")).toContain("''=1+1")
    expect(cellsOf("'=1+1")).not.toContain("'=1+1")
  })

  it('does not put a quote before a negative number', () => {
    expect(
      ledgerCsv([
        {
          number: 1,
          entryDate: '2026-01-15',
          lineNo: 1,
          type: 'manual',
          sourceType: null,
          sourceId: null,
          entryMemo: null,
          lineMemo: null,
          storeId: null,
          partyType: null,
          partyId: null,
          debitCents: 0,
          creditCents: 500,
          runningCents: -500
        }
      ])
    ).toContain(',-500\r\n')
  })

  it('quotes a cell with a comma, a quote or a line break, and doubles the quotes', () => {
    const text = journalCsvRows([row({ entryMemo: 'a, "b"\nc' })])

    expect(text).toContain('"a, ""b""\nc"')
  })
})

describe('the other files', () => {
  it('write the header of the ledger and the trial balance first', () => {
    expect(
      ledgerCsv([])
        .replace(/^\uFEFF/, '')
        .trim()
        .split(',')
    ).toEqual([...LEDGER_CSV_COLUMNS])
    expect(
      trialBalanceCsv([])
        .replace(/^\uFEFF/, '')
        .trim()
    ).toBe('code,name,type,debit_cents,credit_cents,balance_cents')
  })

  it('write the trial balance row of an account', () => {
    expect(
      trialBalanceCsv([
        {
          code: '1101',
          name: 'Caja',
          type: 'asset',
          debitCents: 10,
          creditCents: 4,
          balanceCents: 6
        }
      ])
    ).toContain('1101,Caja,asset,10,4,6\r\n')
  })
})
