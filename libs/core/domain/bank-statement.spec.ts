import {
  type BankStatementProfileShape,
  BankGroupRule,
  BankStatementErrors,
  BankStatementLimits,
  BankThousandsSeparators,
  bankLineKey,
  bankProfileProblem,
  canPair,
  daysBetween,
  groupProblems,
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
  skipRows: 0,
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
  // PUR-003: String.trim() takes U+FEFF as a blank, so a cell that began with one was read as a clean amount or date
  describe('a byte order mark inside a cell', () => {
    const BOM = String.fromCharCode(0xfeff)

    it('is not an amount, in the cell of an amount', () => {
      expect(
        parseBankAmountCents(`${BOM}100.00`, '.', BankThousandsSeparators.NONE, false)
      ).toBeNull()
      expect(
        parseBankAmountCents(`100.00${BOM}`, '.', BankThousandsSeparators.NONE, false)
      ).toBeNull()
    })

    it('refuses the amount and the date of a row, with the code of each, and the file with them', () => {
      const parsed = parseBankStatement(
        `Date,Description,Ref,Amount\n2026-11-02,Deposit,R-1,${BOM}100.00\n${BOM}2026-11-03,Fee,,-1.50\n`,
        signed
      )
      expect(parsed.errors.map(error => [error.row, error.field, error.code])).toEqual([
        [2, 'amount', BankStatementErrors.INVALID_AMOUNT],
        [3, 'date', BankStatementErrors.INVALID_DATE]
      ])
      expect(parsed.errorCount).toBe(2)
    })

    it('is refused in the debit and credit cells, alone or around a dash, and when it is all a date or an amount cell holds', () => {
      const parsed = parseBankStatement(
        [
          'Date,Description,Ref,Debit,Credit',
          `2026-11-02,A,,${BOM},50.00`,
          `2026-11-02,B,,${BOM}-,50.00`,
          `${BOM},C,,5.00,`
        ].join('\n'),
        split
      )
      expect(parsed.errors.map(error => [error.row, error.field, error.code])).toEqual([
        [2, 'debit', BankStatementErrors.INVALID_AMOUNT],
        [3, 'debit', BankStatementErrors.INVALID_AMOUNT],
        [4, 'date', BankStatementErrors.INVALID_DATE]
      ])
      expect(parsed.lines).toEqual([])
    })

    it('is refused when a file opens with it and skips its first rows, in the rows that are read', () => {
      const parsed = parseBankStatement(
        `${BOM}Report of the bank\nDate,Description,Ref,Amount\n2026-11-02,Deposit,R-1,100.00\n2026-11-03,Fee,,${BOM}-1.50\n`,
        { ...signed, skipRows: 1 }
      )
      expect(parsed.errors.map(error => [error.row, error.field, error.code])).toEqual([
        [4, 'amount', BankStatementErrors.INVALID_AMOUNT]
      ])
    })

    it.each([
      [
        'quotes around the header',
        `${BOM}"Date","Description","Ref","Amount"\n2026-11-02,Deposit,R-1,100.00\n`
      ],
      ['CRLF line ends', `${BOM}Date,Description,Ref,Amount\r\n2026-11-02,Deposit,R-1,100.00\r\n`],
      [
        'a blank line before the header',
        `\n${BOM}Date,Description,Ref,Amount\n2026-11-02,Deposit,R-1,100.00\n`
      ],
      // Two exports glued together: the header names are read trimmed, so the second mark costs nothing and no row is lost
      [
        'two marks at the start',
        `${BOM}${BOM}Date,Description,Ref,Amount\n2026-11-02,Deposit,R-1,100.00\n`
      ]
    ])('reads the line of a file that opens with the mark, with %s', (_name, text) => {
      const parsed = parseBankStatement(text, signed)
      expect(parsed.errorCount).toBe(0)
      expect(parsed.lines).toHaveLength(1)
    })

    it('says a file that is only the mark is empty', () => {
      const parsed = parseBankStatement(BOM, signed)
      expect(parsed.errors.map(error => error.code)).toEqual([BankStatementErrors.EMPTY_FILE])
      expect(parsed.lines).toEqual([])
    })

    it('does not touch the one that opens the file (the mark of a UTF-8 file)', () => {
      const parsed = parseBankStatement(
        `${BOM}Date,Description,Ref,Amount\n2026-11-02,Deposit,R-1,100.00\n`,
        signed
      )
      expect(parsed.errorCount).toBe(0)
      expect(parsed.lines).toHaveLength(1)
      const headerless = parseBankStatement(`${BOM}2026-11-02,Deposit,R-1,100.00\n`, {
        ...signed,
        hasHeader: false,
        columns: { date: 0, description: 1, reference: 2, amount: 3 }
      })
      expect(headerless.errorCount).toBe(0)
      expect(headerless.lines).toHaveLength(1)
    })
  })

  it('reads a signed column: money in positive, money out negative', () => {
    const parsed = parseBankStatement(
      'Date,Description,Ref,Amount\n2026-11-02,Deposit,R-1,100.00\n2026-11-03,Fee,,-1.50\n',
      signed
    )
    expect(parsed.errorCount).toBe(0)
    expect(parsed.lines).toEqual([
      {
        postedOn: '2026-11-02',
        postedTime: null,
        amountCents: 10000,
        description: 'Deposit',
        reference: 'R-1',
        row: 2,
        occurrence: 0
      },
      {
        postedOn: '2026-11-03',
        postedTime: null,
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

  it('reads a dash in the column that does not apply as nothing (HC-125)', () => {
    const parsed = parseBankStatement(
      'Date,Description,Ref,Debit,Credit\n2026-11-02,A,,5.00,-\n2026-11-02,B,,--,7.00\n2026-11-02,C,,-,-\n2026-11-02,D,,3.00,3.00\n',
      split
    )
    expect(parsed.lines.map(line => line.amountCents)).toEqual([-500, 700])
    expect(parsed.errors.map(error => [error.row, error.code])).toEqual([
      [4, BankStatementErrors.AMBIGUOUS_DIRECTION],
      [5, BankStatementErrors.AMBIGUOUS_DIRECTION]
    ])
  })

  it('reads a padded dash and a dash next to a 0.00 the same way as an empty cell (HC-125)', () => {
    const parsed = parseBankStatement(
      'Date,Description,Ref,Debit,Credit\n2026-11-02,A,, - ,7.00\n2026-11-02,B,,-,0.00\n2026-11-02,C,,4.00,-\n',
      split
    )
    expect(parsed.lines.map(line => line.amountCents)).toEqual([700, -400])
    expect(parsed.errors.map(error => [error.row, error.code])).toEqual([
      [3, BankStatementErrors.ZERO_AMOUNT]
    ])
  })

  it('still refuses a dash that is not alone, and a dash in the one signed amount column', () => {
    const split2 = parseBankStatement(
      'Date,Description,Ref,Debit,Credit\n2026-11-02,A,,-5.00,\n2026-11-02,B,,---,7.00\n',
      split
    )
    expect(split2.errors.map(error => error.code)).toEqual([
      BankStatementErrors.INVALID_AMOUNT,
      BankStatementErrors.INVALID_AMOUNT
    ])
    const typographic = parseBankStatement(
      'Date,Description,Ref,Debit,Credit\n2026-11-02,A,,5.00,\u2013\n2026-11-02,B,,\u2014,7.00\n',
      split
    )
    expect(typographic.errors.map(error => error.code)).toEqual([
      BankStatementErrors.INVALID_AMOUNT,
      BankStatementErrors.INVALID_AMOUNT
    ])
    const one = parseBankStatement('Date,Description,Ref,Amount\n2026-11-02,A,,-\n', signed)
    expect(one.errors.map(error => error.code)).toEqual([BankStatementErrors.INVALID_AMOUNT])
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
      skipRows: 0,
      decimalSeparator: RemittanceDecimalSeparators.COMMA,
      thousandsSeparator: BankThousandsSeparators.DOT,
      dateFormat: RemittanceDateFormats.DAY_FIRST_SLASH,
      columns: { date: 0, description: 1, reference: 2, amount: 3 }
    })
    expect(parsed.errorCount).toBe(0)
    expect(parsed.lines[0]).toMatchObject({ postedOn: '2026-11-03', amountCents: 123450 })
  })
})

describe('a statement is never read in silence', () => {
  const byPosition: BankStatementProfileShape = {
    ...signed,
    columns: { date: 0, description: 1, reference: 2, amount: 3 }
  }
  const movements = '2026-11-02,Deposit,R-1,100.00\n2026-11-03,Fee,,-1.50\n'

  it('refuses a file with no header when the profile says it has one and maps by position: the first movement is not dropped', () => {
    const parsed = parseBankStatement(movements, byPosition)
    expect(parsed.errorCount).toBeGreaterThan(0)
    expect(parsed.errors[0]).toMatchObject({
      row: 1,
      field: 'date',
      code: BankStatementErrors.HEADER_LOOKS_LIKE_DATA,
      value: '2026-11-02'
    })
    expect(parsed.lines).toEqual([])
  })

  it('points at the line of the file where the first row is, after blank lines and a BOM', () => {
    const parsed = parseBankStatement(`\uFEFF\n\n${movements}`, byPosition)
    expect(parsed.errors[0]).toMatchObject({
      row: 3,
      code: BankStatementErrors.HEADER_LOOKS_LIKE_DATA
    })
  })

  it('reads a file that has the header the profile says, by position', () => {
    const parsed = parseBankStatement(`Date,Description,Ref,Amount\n${movements}`, byPosition)
    expect(parsed.errorCount).toBe(0)
    expect(parsed.lines).toHaveLength(2)
    expect(parsed.lines[0]).toMatchObject({ postedOn: '2026-11-02', amountCents: 10000, row: 2 })
  })

  it('reads a file with no header when the profile says so, and still refuses a header read as a movement', () => {
    const headerless: BankStatementProfileShape = { ...byPosition, hasHeader: false }
    const ok = parseBankStatement(movements, headerless)
    expect(ok.errorCount).toBe(0)
    expect(ok.lines).toHaveLength(2)
    expect(ok.lines[0]).toMatchObject({ row: 1 })
    const withHeader = parseBankStatement(`Date,Description,Ref,Amount\n${movements}`, headerless)
    expect(withHeader.errors[0]).toMatchObject({ row: 1, code: BankStatementErrors.INVALID_DATE })
  })

  it('keeps a line break, a tab or a line separator inside a description as one space and numbers the rows after it by the file', () => {
    const parsed = parseBankStatement(
      'Date,Description,Ref,Amount\n2026-11-02,"Line 1\nLine 2\r\nLine\t3 4",R-1,1.00\n2026-11-03,Next,,abc\n',
      signed
    )
    expect(parsed.lines[0]?.description).toBe('Line 1 Line 2 Line 3 4')
    expect(parsed.lines[0]?.row).toBe(2)
    expect(parsed.errors).toEqual([
      { row: 5, field: 'amount', code: BankStatementErrors.INVALID_AMOUNT, value: 'abc' }
    ])
  })

  it('still refuses a line break in a reference, and any other control character in a description', () => {
    const reference = parseBankStatement(
      'Date,Description,Ref,Amount\n2026-11-02,A,"R\n1",1.00\n',
      signed
    )
    expect(reference.errors[0]).toMatchObject({
      field: 'reference',
      code: BankStatementErrors.INVALID_TEXT
    })
    const control = parseBankStatement(
      'Date,Description,Ref,Amount\n2026-11-02,A\u0000B,,1.00\n',
      signed
    )
    expect(control.errors[0]).toMatchObject({
      field: 'description',
      code: BankStatementErrors.INVALID_TEXT
    })
  })

  it('counts the length of a description and a reference in characters, not in UTF-16 units', () => {
    const limit = BankStatementLimits.DESCRIPTION_MAX_LENGTH
    const exact = `${'x'.repeat(limit - 1)}\u{1F600}`
    const whole = parseBankStatement(
      `Date,Description,Ref,Amount\n2026-11-02,${exact},,1.00\n`,
      signed
    )
    expect(whole.errorCount).toBe(0)
    expect(whole.lines[0]?.description).toBe(exact)
    const cut = parseBankStatement(
      `Date,Description,Ref,Amount\n2026-11-02,${'\u{1F600}'.repeat(limit + 40)},,1.00\n`,
      signed
    )
    expect(cut.errorCount).toBe(0)
    expect(Array.from(cut.lines[0]?.description ?? '')).toHaveLength(limit)
    const referenceLimit = BankStatementLimits.REFERENCE_MAX_LENGTH
    const fits = parseBankStatement(
      `Date,Description,Ref,Amount\n2026-11-02,A,${'\u{1F600}'.repeat(referenceLimit)},1.00\n`,
      signed
    )
    expect(fits.errorCount).toBe(0)
    const over = parseBankStatement(
      `Date,Description,Ref,Amount\n2026-11-02,A,${'\u{1F600}'.repeat(referenceLimit + 1)},1.00\n`,
      signed
    )
    expect(over.errors[0]).toMatchObject({
      field: 'reference',
      code: BankStatementErrors.INVALID_TEXT
    })
  })

  describe('the order of the day and the month', () => {
    const dayFirst: BankStatementProfileShape = {
      ...signed,
      dateFormat: RemittanceDateFormats.DAY_FIRST_SLASH
    }
    const monthFirst: BankStatementProfileShape = {
      ...signed,
      dateFormat: RemittanceDateFormats.MONTH_FIRST_SLASH
    }
    const file = (...days: string[]): string =>
      `Date,Description,Ref,Amount\n${days.map(day => `${day},A,,1.00`).join('\n')}\n`

    it('says the order is undecided when every date reads in both orders', () => {
      expect(
        parseBankStatement(file('03/11/2026', '05/11/2026'), dayFirst).dateFormatUndecided
      ).toBe(true)
      expect(
        parseBankStatement(file('03/11/2026', '05/11/2026'), monthFirst).dateFormatUndecided
      ).toBe(true)
    })

    it('says it is decided when one date can only be read in the order of the profile', () => {
      expect(
        parseBankStatement(file('03/11/2026', '25/11/2026'), dayFirst).dateFormatUndecided
      ).toBe(false)
      expect(
        parseBankStatement(file('03/11/2026', '11/25/2026'), monthFirst).dateFormatUndecided
      ).toBe(false)
    })

    it('has nothing to decide when the day and the month are the same number, or the format has one order', () => {
      expect(parseBankStatement(file('05/05/2026'), dayFirst).dateFormatUndecided).toBe(false)
      expect(parseBankStatement(file('2026-11-03'), signed).dateFormatUndecided).toBe(false)
      expect(
        parseBankStatement(file('03-11-2026'), {
          ...signed,
          dateFormat: RemittanceDateFormats.DAY_FIRST_DASH
        }).dateFormatUndecided
      ).toBe(false)
    })

    it('still refuses a date that cannot be read in the order of the profile', () => {
      const parsed = parseBankStatement(file('03/11/2026', '25/11/2026'), monthFirst)
      expect(parsed.errors).toEqual([
        { row: 3, field: 'date', code: BankStatementErrors.INVALID_DATE, value: '25/11/2026' }
      ])
    })
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

// A file of the shape a bank of the region sends (synthetic: nothing of a real statement is kept): a lead of report lines before the
// movements, comma delimited, a day with a time on most rows and without it on some, debit and credit in their own columns with the
// inactive one at 0.00, and thousands with a comma inside quotes
describe('a statement with a time in its dates and thousands with a comma', () => {
  const bank: BankStatementProfileShape = {
    delimiter: RemittanceDelimiters.COMMA,
    hasHeader: false,
    skipRows: 0,
    decimalSeparator: RemittanceDecimalSeparators.DOT,
    thousandsSeparator: BankThousandsSeparators.COMMA,
    dateFormat: RemittanceDateFormats.DAY_FIRST_SLASH,
    columns: { date: 0, description: 1, reference: 2, debit: 3, credit: 4 }
  }

  it('accepts a comma as thousands separator with a comma as delimiter', () => {
    expect(
      bankProfileProblem({
        hasHeader: false,
        delimiter: ',',
        decimalSeparator: '.',
        thousandsSeparator: 'comma',
        columns: { date: 0, debit: 1, credit: 2 }
      })
    ).toBeNull()
    // The other collisions still hold
    expect(
      bankProfileProblem({
        hasHeader: false,
        delimiter: ';',
        decimalSeparator: ',',
        thousandsSeparator: 'comma',
        columns: { date: 0, amount: 1 }
      })
    ).not.toBeNull()
    expect(
      bankProfileProblem({
        hasHeader: false,
        delimiter: ',',
        decimalSeparator: ',',
        thousandsSeparator: 'none',
        columns: { date: 0, amount: 1 }
      })
    ).not.toBeNull()
  })

  it('reads "9,999.99" inside quotes as 999999 cents, in debit and in credit', () => {
    const parsed = parseBankStatement(
      '02/11/2026,Deposit,R1,0.00,"9,999.99"\n03/11/2026,Payment,R2,"1,234.50",0.00\n',
      bank
    )
    expect(parsed.errorCount).toBe(0)
    expect(parsed.lines.map(line => line.amountCents)).toEqual([999999, -123450])
  })

  it('still refuses a thousands separator that is not quoted: the cell breaks, the amount is never read wrong', () => {
    // 9,999.99 unquoted becomes two cells: the row is wider than the file and the credit reads "9"
    const parsed = parseBankStatement(
      [
        '02/11/2026,Deposit,R1,0.00,9,999.99',
        '03/11/2026,Payment,R2,1.00,0.00',
        '03/11/2026,Payment,R3,2.00,0.00',
        ''
      ].join('\n'),
      bank
    )
    expect(parsed.errorCount).toBeGreaterThan(0)
    expect(parsed.errors.map(error => error.code)).toContain(BankStatementErrors.ROW_TOO_WIDE)
    expect(parsed.lines.map(line => line.amountCents)).not.toContain(999)
    expect(parsed.lines.map(line => line.amountCents)).not.toContain(999999)
    // And groups that are not of three digits, quoted or not, are no amount
    const loose = parseBankStatement('02/11/2026,Deposit,R1,0.00,"99,99.99"\n', bank)
    expect(loose.errors[0]).toMatchObject({ code: BankStatementErrors.INVALID_AMOUNT })
    expect(loose.lines).toEqual([])
  })

  it('refuses a row that does not have the cells of the file when the delimiter is also the thousands separator', () => {
    // An empty cell at the end must not hide the shift of an unquoted 1,234.50
    const withBalance: BankStatementProfileShape = {
      ...bank,
      hasHeader: true,
      columns: { date: 'Date', description: 'Desc', reference: 'Ref', amount: 'Amount' }
    }
    const header = 'Date,Desc,Ref,Amount,Balance'
    const hidden = parseBankStatement(
      `${header}\n14/11/2026,A,R1,1,234.50,\n15/11/2026,B,R2,5.00,\n`,
      withBalance
    )
    expect(hidden.errors.map(error => [error.row, error.code])).toEqual([
      [2, BankStatementErrors.ROW_TOO_WIDE]
    ])
    // The shifted row is never read as 1.00: the file is refused as a whole by its error count
    expect(hidden.lines.map(line => line.amountCents)).not.toContain(100)
    // With no header, a modal width inflated by unquoted amounts does not let them through: the rows of another width are refused
    const noHeader = parseBankStatement(
      [
        '14/11/2026,A,R1,0.00,9,999.99',
        '14/11/2026,B,R2,0.00,8,888.88',
        '15/11/2026,C,R3,0.00,5.00'
      ].join('\n'),
      bank
    )
    expect(noHeader.errorCount).toBeGreaterThan(0)
    expect(noHeader.lines.map(line => line.amountCents)).not.toContain(900)
    // Even when EVERY row has the unquoted amount, so that the width most rows have is the wrong one
    const allSplit = parseBankStatement(
      ['14/11/2026,A,R1,0.00,9,999.99', '14/11/2026,B,R2,0.00,8,888.88'].join('\n'),
      bank
    )
    expect(allSplit.errors.map(error => error.code)).toEqual([
      BankStatementErrors.INVALID_AMOUNT,
      BankStatementErrors.INVALID_AMOUNT
    ])
    expect(allSplit.lines).toEqual([])
    // Quoted, the same rows read
    const quoted = parseBankStatement(
      `${header}\n14/11/2026,A,R1,"1,234.50",\n15/11/2026,B,R2,5.00,\n`,
      withBalance
    )
    expect(quoted.errorCount).toBe(0)
    expect(quoted.lines.map(line => line.amountCents)).toEqual([123450, 500])
  })

  it('reads the day of a date with a time, keeps the time, and a day alone has none', () => {
    const parsed = parseBankStatement(
      [
        '02/11/2026 10:15:30,With time,R1,0.00,5.00',
        '02/11/2026,Day only,R2,0.00,6.00',
        '02/11/2026 23:59,No seconds,R3,7.00,0.00',
        ''
      ].join('\r\n'),
      bank
    )
    expect(parsed.errorCount).toBe(0)
    expect(parsed.lines.map(line => [line.postedOn, line.postedTime])).toEqual([
      ['2026-11-02', '10:15:30'],
      ['2026-11-02', null],
      ['2026-11-02', '23:59:00']
    ])
  })

  it('refuses a time that does not exist or has text after it, row by row', () => {
    const parsed = parseBankStatement(
      [
        '02/11/2026 25:61:00,A,R1,0.00,5.00',
        '02/11/2026 10:00:00 pm,B,R2,0.00,5.00',
        '02/11/2026 10:00:00,C,R3,0.00,5.00'
      ].join('\n'),
      bank
    )
    expect(parsed.errors.map(error => [error.row, error.field, error.code])).toEqual([
      [1, 'date', BankStatementErrors.INVALID_DATE],
      [2, 'date', BankStatementErrors.INVALID_DATE]
    ])
    // The row that reads is a line like any other; the file is refused as a whole by its error count
    expect(parsed.errorCount).toBe(2)
    expect(parsed.lines.map(line => line.description)).toEqual(['C'])
  })

  it('takes the order of the day and the month from the day of a date that has a time', () => {
    const decisive = parseBankStatement(
      '25/11/2026 10:00:00,A,R1,0.00,5.00\n03/11/2026 10:00:00,B,R2,0.00,5.00\n',
      bank
    )
    expect(decisive.dateFormatUndecided).toBe(false)
    const ambiguous = parseBankStatement('03/11/2026 10:00:00,A,R1,0.00,5.00\n', bank)
    expect(ambiguous.dateFormatUndecided).toBe(true)
  })

  it('never takes a first row whose date has a time for the header', () => {
    const parsed = parseBankStatement(
      '02/11/2026 10:15:30,A,R1,0.00,5.00\n03/11/2026 10:15:30,B,R2,0.00,6.00\n',
      { ...bank, hasHeader: true }
    )
    expect(parsed.errors.map(error => error.code)).toContain(
      BankStatementErrors.HEADER_LOOKS_LIKE_DATA
    )
    expect(parsed.lines).toEqual([])
  })

  it('gives two identical lines of different times their own keys, and the same line the same key whichever file brings it', () => {
    const line = (time: string | null, occurrence = 0) => ({
      postedOn: '2026-11-02',
      postedTime: time,
      amountCents: 500,
      description: 'X',
      reference: 'R',
      row: 1,
      occurrence
    })
    // Two equal movements of the same day at two times are two lines
    expect(bankLineKey('acc', line('10:00:00'))).not.toBe(bankLineKey('acc', line('11:00:00')))
    // The same movement in an overlapping statement is the same line, whichever row it has there
    expect(bankLineKey('acc', { ...line('11:00:00'), row: 40 })).toBe(
      bankLineKey('acc', { ...line('11:00:00'), row: 3 })
    )
    // A line with no time keeps the key it always had, so what was imported before is still known
    expect(bankLineKey('acc', line(null))).toBe(
      ['acc', '2026-11-02', '500', 'R', 'X', '0'].join('\u0000')
    )
    expect(bankLineKey('acc', line('10:00:00'))).not.toBe(bankLineKey('acc', line(null)))
  })

  it('does not double the lines an overlapping statement repeats, nor merge two of different times', () => {
    const first = [
      '02/11/2026 10:00:00,X,R,0.00,5.00',
      '02/11/2026 11:00:00,X,R,0.00,5.00',
      '03/11/2026,Y,R9,2.00,0.00'
    ].join('\n')
    // The next statement starts at the second line of the day: it brings it again, alone, with the same time
    const second = [
      '02/11/2026 11:00:00,X,R,0.00,5.00',
      '03/11/2026,Y,R9,2.00,0.00',
      '04/11/2026 08:00:00,Z,R7,0.00,9.00'
    ].join('\n')
    const keys = (text: string): string[] =>
      parseBankStatement(text, bank).lines.map(line => bankLineKey('acc', line))
    const known = new Set(keys(first))
    expect(known.size).toBe(3)
    const fresh = keys(second).filter(key => !known.has(key))
    // Only the 4 November line is new: the 11:00 line (same time) and the day-only line were known
    expect(fresh).toHaveLength(1)
    // Identical lines at the SAME time are still two lines, numbered in file order
    const twins = parseBankStatement(
      '02/11/2026 10:00:00,X,R,0.00,5.00\n02/11/2026 10:00:00,X,R,0.00,5.00\n',
      bank
    )
    expect(twins.lines.map(line => line.occurrence)).toEqual([0, 1])
    expect(new Set(twins.lines.map(line => bankLineKey('acc', line))).size).toBe(2)
  })
})

// The lead of report lines some banks print before the movements (synthetic, in the shape of a real one): titles, a quoted title with a
// line break inside, blank rows, the opening and closing balances, and then a row of column titles and the movements
describe('a statement that starts with a lead of report lines', () => {
  const row = (cells: Record<number, string>, width = 12): string =>
    Array.from({ length: width }, (_, index) => {
      const cell = cells[index] ?? ''
      return /[",\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell
    }).join(',')
  const lead = [
    row({}),
    row({}),
    row({ 3: 'Statement of account' }),
    row({ 3: 'Period\nfrom a day to a day' }),
    row({}),
    row({ 0: 'Opening balance:', 6: 'Total', 10: '100.00' }),
    row({ 2: 'Product name and number' }),
    row({}),
    row({ 0: 'Closing balance:', 10: '(50.25)' }),
    row({}),
    row({ 1: 'Date', 3: 'Type', 5: 'Memo', 7: 'Ref', 8: 'Debit', 9: 'Credit', 11: 'Balance' })
  ]
  const movements = [
    row({
      1: '14/11/2026 10:15:30',
      3: 'AB',
      5: 'Deposit',
      7: '1001',
      8: '0.00',
      9: '1,234.50',
      11: '1,334.50'
    }),
    row({ 1: '15/11/2026', 3: 'CA', 5: 'Fee', 8: '2.00', 9: '0.00', 11: '(40.00)' })
  ]
  const text = [...lead, ...movements].join('\r\n') + '\r\n'
  // The records of the lead that are not blank: 6, the row of titles included (the blank rows are not counted, the quoted title is one)
  const base: BankStatementProfileShape = {
    delimiter: RemittanceDelimiters.COMMA,
    hasHeader: false,
    skipRows: 6,
    decimalSeparator: RemittanceDecimalSeparators.DOT,
    thousandsSeparator: BankThousandsSeparators.COMMA,
    dateFormat: RemittanceDateFormats.DAY_FIRST_SLASH,
    columns: { date: 1, description: 5, reference: 7, debit: 8, credit: 9 }
  }

  it('does not read what is skipped, counts records and not lines, and reads the movements by position', () => {
    const parsed = parseBankStatement(text, base)
    expect(parsed.errorCount).toBe(0)
    expect(parsed.lines.map(line => [line.postedOn, line.postedTime, line.amountCents])).toEqual([
      ['2026-11-14', '10:15:30', 123450],
      ['2026-11-15', null, -200]
    ])
  })

  it('reads by the titles of the columns when the skip stops right before them', () => {
    const parsed = parseBankStatement(text, {
      ...base,
      hasHeader: true,
      skipRows: 5,
      columns: {
        date: 'Date',
        description: 'Memo',
        reference: 'Ref',
        debit: 'Debit',
        credit: 'Credit'
      }
    })
    expect(parsed.errorCount).toBe(0)
    expect(parsed.headers).toContain('Debit')
    expect(parsed.lines).toHaveLength(2)
  })

  it('points an error at the line of the file, whatever was skipped before it', () => {
    const broken = [...lead, row({ 1: '99/99/2026', 8: '1.00', 9: '0.00' })].join('\r\n')
    const parsed = parseBankStatement(broken, base)
    // 11 rows of the lead, one of them is two lines long: the bad row is on line 13 of the file
    expect(parsed.errors[0]).toMatchObject({
      row: 13,
      field: 'date',
      code: BankStatementErrors.INVALID_DATE
    })
  })

  it('reads nothing of the lead: a stray quote or a wide row in it is of no consequence', () => {
    const messy = ['"abc"def,x', 'a,b,c,d,e,f,g,h,i,j,k,l,m,n,o', ...movements].join('\n')
    const parsed = parseBankStatement(messy, { ...base, skipRows: 2 })
    expect(parsed.errorCount).toBe(0)
    expect(parsed.lines).toHaveLength(2)
  })

  it('skips none by default and refuses a file that is all skipped', () => {
    expect(parseBankStatement(text, { ...base, skipRows: 0 }).errorCount).toBeGreaterThan(0)
    const all = parseBankStatement(text, { ...base, skipRows: 50 })
    // The file has 6 records of lead and 2 movements: 8, and the profile skips more than that
    expect(all.errors).toEqual([
      { row: 1, field: null, code: BankStatementErrors.SKIP_PAST_END, value: '8' }
    ])
    expect(all.lines).toEqual([])
  })
})

describe('groupProblems (one statement line against several lines of the books)', () => {
  const lines = (...cents: number[]) =>
    cents.map((signedCents, index) => ({ id: `l${index}`, signedCents }))

  it('accepts a group that adds up to the cent, a deposit net of a fee included', () => {
    expect(
      groupProblems({ statementCents: 150_000, lines: lines(50_000, 60_000, 40_000) })
    ).toEqual([])
    expect(groupProblems({ statementCents: 149_700, lines: lines(150_000, -300) })).toEqual([])
  })

  it('refuses a sum that is off by one cent, in either direction and with the wrong sign', () => {
    expect(groupProblems({ statementCents: 100, lines: lines(60, 39) })).toEqual([
      BankGroupRule.SUM
    ])
    expect(groupProblems({ statementCents: 100, lines: lines(60, 41) })).toEqual([
      BankGroupRule.SUM
    ])
    expect(groupProblems({ statementCents: -100, lines: lines(60, 40) })).toEqual([
      BankGroupRule.SUM
    ])
  })

  it('refuses a group of fewer than two lines, of more than the most, and a line named twice', () => {
    expect(groupProblems({ statementCents: 100, lines: lines(100) })).toEqual([BankGroupRule.SIZE])
    expect(groupProblems({ statementCents: 0, lines: [] })).toEqual([BankGroupRule.SIZE])
    const many = lines(...new Array<number>(BankStatementLimits.MAX_GROUP + 1).fill(1))
    expect(groupProblems({ statementCents: many.length, lines: many })).toEqual([
      BankGroupRule.SIZE
    ])
    const twice = [
      { id: 'same', signedCents: 50 },
      { id: 'same', signedCents: 50 }
    ]
    expect(groupProblems({ statementCents: 100, lines: twice })).toEqual([BankGroupRule.DUPLICATE])
  })

  it('accepts exactly the smallest and the largest group, and refuses a sum that is not a safe integer', () => {
    const smallest = lines(30, 70)
    expect(groupProblems({ statementCents: 100, lines: smallest })).toEqual([])
    const largest = lines(...new Array<number>(BankStatementLimits.MAX_GROUP).fill(2))
    expect(
      groupProblems({ statementCents: BankStatementLimits.MAX_GROUP * 2, lines: largest })
    ).toEqual([])
    const huge = [
      { id: 'a', signedCents: Number.MAX_SAFE_INTEGER },
      { id: 'b', signedCents: Number.MAX_SAFE_INTEGER }
    ]
    expect(groupProblems({ statementCents: Number.MAX_SAFE_INTEGER * 2, lines: huge })).toEqual([
      BankGroupRule.SUM
    ])
  })

  it('reports every problem at once', () => {
    expect(groupProblems({ statementCents: 5, lines: [{ id: 'a', signedCents: 1 }] })).toEqual([
      BankGroupRule.SIZE,
      BankGroupRule.SUM
    ])
  })
})
