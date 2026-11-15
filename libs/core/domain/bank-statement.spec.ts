import {
  type BankStatementProfileShape,
  BankStatementErrors,
  BankStatementLimits,
  BankThousandsSeparators,
  bankProfileProblem,
  canPair,
  daysBetween,
  parseBankAmountCents,
  parseBankStatement,
  referencesAgree,
  suggestMatches,
  unambiguousExactPairs
} from './bank-statement'
import {
  RemittanceDateFormats,
  RemittanceDecimalSeparators,
  RemittanceDelimiters
} from './remittance-import'

const signed: BankStatementProfileShape = {
  delimiter: RemittanceDelimiters.COMMA,
  hasHeader: true,
  decimalSeparator: RemittanceDecimalSeparators.DOT,
  thousandsSeparator: BankThousandsSeparators.NONE,
  dateFormat: RemittanceDateFormats.ISO,
  columns: { date: 'Date', description: 'Description', reference: 'Ref', amount: 'Amount' }
}
const split: BankStatementProfileShape = {
  ...signed,
  columns: {
    date: 'Date',
    description: 'Description',
    reference: 'Ref',
    debit: 'Debit',
    credit: 'Credit'
  }
}

describe('parseBankAmountCents', () => {
  const dot = RemittanceDecimalSeparators.DOT
  const comma = RemittanceDecimalSeparators.COMMA
  const none = BankThousandsSeparators.NONE

  it('reads digits with at most two decimals and an optional sign, to signed cents', () => {
    expect(parseBankAmountCents('12', dot, none, true)).toBe(1200)
    expect(parseBankAmountCents('12.5', dot, none, true)).toBe(1250)
    expect(parseBankAmountCents('-12.05', dot, none, true)).toBe(-1205)
    expect(parseBankAmountCents('+0.01', dot, none, true)).toBe(1)
    expect(parseBankAmountCents(' 7,50 ', comma, none, true)).toBe(750)
  })

  it('never reads what is not an amount as a number', () => {
    for (const cell of [
      'abc',
      '',
      '1e3',
      '$12',
      '(12.00)',
      '12.345',
      '1,234.50',
      '--1',
      '1 000',
      '12.',
      '.5'
    ]) {
      expect(parseBankAmountCents(cell, dot, none, true)).toBeNull()
    }
  })

  it('refuses a sign where the column has none, and an amount past the Int of the books', () => {
    expect(parseBankAmountCents('-5.00', dot, none, false)).toBeNull()
    expect(parseBankAmountCents('+5.00', dot, none, false)).toBeNull()
    expect(parseBankAmountCents('21474836.48', dot, none, true)).toBeNull()
    expect(parseBankAmountCents('21474836.47', dot, none, true)).toBe(2_147_483_647)
  })

  it('takes a thousands separator only in groups of three and only when the profile says so', () => {
    expect(parseBankAmountCents('1,234.50', dot, BankThousandsSeparators.COMMA, true)).toBe(123450)
    expect(parseBankAmountCents('1.234,50', comma, BankThousandsSeparators.DOT, true)).toBe(123450)
    expect(parseBankAmountCents('1 234,50', comma, BankThousandsSeparators.SPACE, true)).toBe(
      123450
    )
    expect(parseBankAmountCents('1,23.50', dot, BankThousandsSeparators.COMMA, true)).toBeNull()
    expect(parseBankAmountCents('1,2345.00', dot, BankThousandsSeparators.COMMA, true)).toBeNull()
    expect(parseBankAmountCents('1234.50', dot, BankThousandsSeparators.COMMA, true)).toBe(123450)
    expect(parseBankAmountCents('1,234.50', dot, none, true)).toBeNull()
  })
})

describe('bankProfileProblem', () => {
  const base = {
    hasHeader: true,
    delimiter: ',',
    decimalSeparator: '.',
    thousandsSeparator: 'none'
  }
  it('accepts one signed column, or a debit and a credit', () => {
    expect(bankProfileProblem({ ...base, columns: { date: 'D', amount: 'A' } })).toBeNull()
    expect(
      bankProfileProblem({ ...base, columns: { date: 'D', debit: 'X', credit: 'Y' } })
    ).toBeNull()
  })
  it('refuses both ways at once, neither, or half of the split', () => {
    expect(bankProfileProblem({ ...base, columns: { date: 'D' } })).not.toBeNull()
    expect(
      bankProfileProblem({ ...base, columns: { date: 'D', amount: 'A', debit: 'X', credit: 'Y' } })
    ).not.toBeNull()
    expect(bankProfileProblem({ ...base, columns: { date: 'D', debit: 'X' } })).not.toBeNull()
  })
  it('refuses a reused column, names without a header and separators that collide', () => {
    expect(bankProfileProblem({ ...base, columns: { date: 'D', amount: ' d ' } })).not.toBeNull()
    expect(
      bankProfileProblem({ ...base, hasHeader: false, columns: { date: 'D', amount: 1 } })
    ).not.toBeNull()
    expect(
      bankProfileProblem({ ...base, decimalSeparator: ',', columns: { date: 0, amount: 1 } })
    ).not.toBeNull()
    expect(
      bankProfileProblem({
        ...base,
        thousandsSeparator: 'dot',
        columns: { date: 'D', amount: 'A' }
      })
    ).not.toBeNull()
    expect(
      bankProfileProblem({
        ...base,
        delimiter: ';',
        decimalSeparator: ',',
        thousandsSeparator: 'comma',
        columns: { date: 'D', amount: 'A' }
      })
    ).not.toBeNull()
  })
})

describe('parseBankStatement', () => {
  it('reads a signed column: money in positive, money out negative', () => {
    const parsed = parseBankStatement(
      'Date,Description,Ref,Amount\n2026-11-02,Deposit,R-1,100.00\n2026-11-03,Fee,,-1.50\n',
      signed
    )
    expect(parsed.errorCount).toBe(0)
    expect(parsed.lines).toEqual([
      {
        postedOn: '2026-11-02',
        amountCents: 10000,
        description: 'Deposit',
        reference: 'R-1',
        row: 2,
        occurrence: 0
      },
      {
        postedOn: '2026-11-03',
        amountCents: -150,
        description: 'Fee',
        reference: null,
        row: 3,
        occurrence: 0
      }
    ])
  })

  it('reads debit and credit columns, and refuses a row that fills both or neither', () => {
    const parsed = parseBankStatement(
      'Date,Description,Ref,Debit,Credit\n2026-11-02,A,,5.00,\n2026-11-02,B,,,7.00\n2026-11-02,C,,1.00,1.00\n2026-11-02,D,,,\n',
      split
    )
    expect(parsed.lines.map(line => line.amountCents)).toEqual([-500, 700])
    expect(parsed.errors.map(error => [error.row, error.code])).toEqual([
      [4, BankStatementErrors.AMBIGUOUS_DIRECTION],
      [5, BankStatementErrors.AMBIGUOUS_DIRECTION]
    ])
  })

  it('reads a 0.00 in the column that does not apply as nothing, and refuses a row that says nothing at all', () => {
    const parsed = parseBankStatement(
      'Date,Description,Ref,Debit,Credit\n2026-11-02,A,,5.00,0.00\n2026-11-02,B,,0.00,7.00\n2026-11-02,C,,0.00,0.00\n2026-11-02,D,,3.00,3.00\n',
      split
    )
    expect(parsed.lines.map(line => line.amountCents)).toEqual([-500, 700])
    expect(parsed.errors.map(error => [error.row, error.code])).toEqual([
      [4, BankStatementErrors.ZERO_AMOUNT],
      [5, BankStatementErrors.AMBIGUOUS_DIRECTION]
    ])
  })

  it('refuses a sign inside a debit or credit column and a zero amount', () => {
    const parsed = parseBankStatement(
      'Date,Description,Ref,Debit,Credit\n2026-11-02,A,,-5.00,\n2026-11-02,B,,,0.00\n',
      split
    )
    expect(parsed.lines).toEqual([])
    expect(parsed.errors.map(error => error.code)).toEqual([
      BankStatementErrors.INVALID_AMOUNT,
      BankStatementErrors.ZERO_AMOUNT
    ])
  })

  it('gives each of two identical lines its own number, the same way every time', () => {
    const text =
      'Date,Description,Ref,Amount\n2026-11-02,X,R,5.00\n2026-11-02,X,R,5.00\n2026-11-02,X,R,6.00\n'
    const first = parseBankStatement(text, signed)
    const again = parseBankStatement(text, signed)
    expect(first.lines.map(line => line.occurrence)).toEqual([0, 1, 0])
    expect(again.lines).toEqual(first.lines)
  })

  it('keeps a cell that starts with a formula character as text, never evaluated', () => {
    const parsed = parseBankStatement(
      'Date,Description,Ref,Amount\n2026-11-02,"=HYPERLINK(""http://x"")",+cmd,10.00\n',
      signed
    )
    expect(parsed.errorCount).toBe(0)
    expect(parsed.lines[0]?.description).toBe('=HYPERLINK("http://x")')
    expect(parsed.lines[0]?.reference).toBe('+cmd')
  })

  it('reports every kind of bad row and reads none of them as zero', () => {
    const parsed = parseBankStatement(
      [
        'Date,Description,Ref,Amount',
        '31/02/2026,A,,1.00',
        '2026-11-02,B,,abc',
        '2026-11-02,C,,',
        ',D,,1.00',
        '2026-11-02,E\u0007,,1.00',
        '2026-11-02,F,,1.00,extra',
        '2026-13-40,G,,1.00'
      ].join('\n'),
      signed
    )
    expect(parsed.lines).toEqual([])
    expect(parsed.errors.map(error => error.code)).toEqual([
      BankStatementErrors.INVALID_DATE,
      BankStatementErrors.INVALID_AMOUNT,
      BankStatementErrors.EMPTY_VALUE,
      BankStatementErrors.EMPTY_VALUE,
      BankStatementErrors.INVALID_TEXT,
      BankStatementErrors.ROW_TOO_WIDE,
      BankStatementErrors.INVALID_DATE
    ])
    expect(parsed.errorCount).toBe(7)
  })

  it('cuts a description that is too long instead of refusing the statement', () => {
    const long = 'x'.repeat(BankStatementLimits.DESCRIPTION_MAX_LENGTH + 50)
    const parsed = parseBankStatement(
      `Date,Description,Ref,Amount\n2026-11-02,${long},,1.00\n`,
      signed
    )
    expect(parsed.errorCount).toBe(0)
    expect(parsed.lines[0]?.description).toHaveLength(BankStatementLimits.DESCRIPTION_MAX_LENGTH)
  })

  it('refuses a mapping that names a column the file has not, or names twice', () => {
    const missing = parseBankStatement('Date,Description,Amount\n2026-11-02,A,1.00\n', signed)
    expect(missing.errors[0]).toMatchObject({
      field: 'reference',
      code: BankStatementErrors.COLUMN_NOT_FOUND
    })
    const twice = parseBankStatement(
      'Date,Amount,Amount,Ref,Description\n2026-11-02,1.00,2.00,R,A\n',
      signed
    )
    expect(twice.errors.map(error => error.code)).toContain(BankStatementErrors.COLUMN_AMBIGUOUS)
  })

  it('refuses an empty file, a header with no rows, an open quote and glued text after a quote', () => {
    expect(parseBankStatement('', signed).errors[0]?.code).toBe(BankStatementErrors.EMPTY_FILE)
    expect(parseBankStatement('Date,Description,Ref,Amount\n', signed).errors[0]?.code).toBe(
      BankStatementErrors.EMPTY_FILE
    )
    expect(
      parseBankStatement('Date,Description,Ref,Amount\n2026-11-02,"open,,1.00\n', signed).errors[0]
        ?.code
    ).toBe(BankStatementErrors.UNCLOSED_QUOTE)
    expect(
      parseBankStatement('Date,Description,Ref,Amount\n2026-11-02,A,,"1.00"0\n', signed).errors[0]
        ?.code
    ).toBe(BankStatementErrors.STRAY_QUOTE)
  })

  it('refuses more rows than a statement may have', () => {
    const rows = Array.from(
      { length: BankStatementLimits.MAX_ROWS + 1 },
      (_, index) => `2026-11-02,A${index},,1.00`
    )
    const parsed = parseBankStatement(`Date,Description,Ref,Amount\n${rows.join('\n')}\n`, signed)
    expect(parsed.errors[0]?.code).toBe(BankStatementErrors.TOO_MANY_ROWS)
    expect(parsed.lines).toEqual([])
  })

  it('reads by position when the file has no header, and with the formats of the profile', () => {
    const parsed = parseBankStatement('03/11/2026;Pago;REF1;1.234,50\n', {
      delimiter: RemittanceDelimiters.SEMICOLON,
      hasHeader: false,
      decimalSeparator: RemittanceDecimalSeparators.COMMA,
      thousandsSeparator: BankThousandsSeparators.DOT,
      dateFormat: RemittanceDateFormats.DAY_FIRST_SLASH,
      columns: { date: 0, description: 1, reference: 2, amount: 3 }
    })
    expect(parsed.errorCount).toBe(0)
    expect(parsed.lines[0]).toMatchObject({ postedOn: '2026-11-03', amountCents: 123450 })
  })
})

describe('matching', () => {
  const line = (
    id: string,
    postedOn: string,
    amountCents: number,
    reference: string | null = null
  ) => ({
    id,
    postedOn,
    amountCents,
    reference
  })
  const book = (id: string, entryDate: string, signedCents: number, texts: string[] = []) => ({
    id,
    entryDate,
    signedCents,
    texts
  })

  it('counts whole days between two days', () => {
    expect(daysBetween('2026-11-01', '2026-11-04')).toBe(3)
    expect(daysBetween('2026-11-04', '2026-11-01')).toBe(3)
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1)
  })

  it('suggests only the same amount in the same direction inside the window', () => {
    const found = suggestMatches(
      [line('L', '2026-11-10', 5000)],
      [
        book('same-day', '2026-11-10', 5000),
        book('edge', '2026-11-13', 5000),
        book('outside', '2026-11-14', 5000),
        book('other-way', '2026-11-10', -5000),
        book('other-amount', '2026-11-10', 5001)
      ],
      3,
      new Set()
    )
    expect(found.get('L')?.map(s => s.bookLineId)).toEqual(['same-day', 'edge'])
    expect(found.get('L')?.map(s => s.exact)).toEqual([true, false])
  })

  it('puts a reference that agrees first, makes it exact, and never lets a short one count', () => {
    const found = suggestMatches(
      [line('L', '2026-11-10', 5000, 'INV-2044'), line('S', '2026-11-10', 5000, '4')],
      [
        book('near', '2026-11-10', 5000),
        book('ref', '2026-11-12', 5000, ['Invoice inv-2044 paid'])
      ],
      3,
      new Set()
    )
    expect(found.get('L')?.map(s => s.bookLineId)).toEqual(['ref', 'near'])
    expect(found.get('L')?.[0]).toMatchObject({ referenceMatch: true, exact: true })
    expect(found.get('S')?.every(s => !s.referenceMatch)).toBe(true)
    expect(referencesAgree('abc', ['abc'])).toBe(false)
    expect(referencesAgree('abcd', ['xx abcd'])).toBe(false)
    expect(referencesAgree('ab12', ['xx AB12 yy'])).toBe(true)
    expect(referencesAgree('TRANSFERENCIA PAGO PROVEEDOR', ['Pago'])).toBe(false)
    expect(referencesAgree('PAGO INV-2044', ['INV-2044'])).toBe(true)
    expect(referencesAgree('0012', ['INV-100125'])).toBe(false)
    expect(referencesAgree('0012', ['Caja 2026'])).toBe(false)
    expect(referencesAgree('0012', ['ref 0012.'])).toBe(true)
    expect(referencesAgree(null, ['abcd'])).toBe(false)
  })

  it('does not suggest again a pair that was rejected', () => {
    const found = suggestMatches(
      [line('L', '2026-11-10', 5000)],
      [book('B', '2026-11-10', 5000)],
      3,
      new Set(['L:B'])
    )
    expect(found.get('L')).toEqual([])
  })

  it('offers for a bulk confirmation only the single, exact, unclaimed ones', () => {
    const suggestions = suggestMatches(
      [
        line('alone', '2026-11-10', 100),
        line('two-a', '2026-11-10', 200),
        line('rival-1', '2026-11-10', 300),
        line('rival-2', '2026-11-10', 300),
        line('days-off', '2026-11-12', 400),
        line('two-options', '2026-11-10', 500)
      ],
      [
        book('b-alone', '2026-11-10', 100),
        book('b-two', '2026-11-10', 200),
        book('b-rival', '2026-11-10', 300),
        book('b-days', '2026-11-10', 400),
        book('b-opt-1', '2026-11-10', 500),
        book('b-opt-2', '2026-11-11', 500)
      ],
      3,
      new Set()
    )
    expect(unambiguousExactPairs(suggestions)).toEqual([
      { lineId: 'alone', bookLineId: 'b-alone' },
      { lineId: 'two-a', bookLineId: 'b-two' }
    ])
  })

  it('checks a pair the way a person confirmation must pass', () => {
    const statement = { postedOn: '2026-11-10', amountCents: -250 }
    expect(canPair(statement, { entryDate: '2026-11-12', signedCents: -250 }, 3)).toBe(true)
    expect(canPair(statement, { entryDate: '2026-11-14', signedCents: -250 }, 3)).toBe(false)
    expect(canPair(statement, { entryDate: '2026-11-10', signedCents: 250 }, 3)).toBe(false)
    expect(canPair(statement, { entryDate: '2026-11-10', signedCents: -251 }, 3)).toBe(false)
  })
})
