import {
  parseImportDay,
  parseMoneyCents,
  parseRemittanceFile,
  RemittanceDateFormats,
  RemittanceDecimalSeparators,
  RemittanceDelimiters,
  RemittanceImportErrors,
  type RemittanceImportProfileShape,
  splitDelimited
} from './remittance-import'

const profile = (
  over: Partial<RemittanceImportProfileShape> = {}
): RemittanceImportProfileShape => ({
  delimiter: RemittanceDelimiters.COMMA,
  hasHeader: true,
  decimalSeparator: RemittanceDecimalSeparators.DOT,
  dateFormat: RemittanceDateFormats.ISO,
  columns: { guideNumber: 'Guia', amount: 'Monto' },
  ...over
})

describe('splitDelimited', () => {
  it('reads quotes, doubled quotes, delimiters and line breaks inside a cell, and the BOM', () => {
    const { rows, unclosedQuote } = splitDelimited('﻿a,"b,1","say ""hi""","x\ny"\r\nc,d\n', ',')
    expect(unclosedQuote).toBe(false)
    expect(rows).toEqual([
      ['a', 'b,1', 'say "hi"', 'x\ny'],
      ['c', 'd']
    ])
  })
  it('reads a tab as the delimiter and keeps an empty trailing cell', () => {
    expect(splitDelimited('a\tb\t\n', '\t').rows).toEqual([['a', 'b', '']])
  })
  it('says when a quote is never closed', () => {
    expect(splitDelimited('a,"b\nc', ',').unclosedQuote).toBe(true)
  })
  it('returns no row for no text', () => {
    expect(splitDelimited('', ',').rows).toEqual([])
  })
})

describe('parseMoneyCents', () => {
  it('reads whole amounts and one or two decimals with the separator of the profile', () => {
    expect(parseMoneyCents('12', '.')).toBe(1200)
    expect(parseMoneyCents(' 12.5 ', '.')).toBe(1250)
    expect(parseMoneyCents('12.05', '.')).toBe(1205)
    expect(parseMoneyCents('0.99', '.')).toBe(99)
    expect(parseMoneyCents('12,50', ',')).toBe(1250)
    expect(parseMoneyCents('0', '.')).toBe(0)
  })
  it('refuses everything else instead of reading it as zero or guessing a locale', () => {
    for (const cell of [
      '',
      ' ',
      'abc',
      '1,234.50',
      '1.234,50',
      '$12',
      '12 USD',
      '-5',
      '+5',
      '1e3',
      '12.345',
      '12.',
      '.5',
      '1 000',
      '0x10',
      '١٢'
    ]) {
      expect(parseMoneyCents(cell, '.')).toBeNull()
    }
    // The other separator is not the decimal one of this profile
    expect(parseMoneyCents('12,50', '.')).toBeNull()
    expect(parseMoneyCents('12.50', ',')).toBeNull()
  })
  it('refuses an amount larger than a line may hold', () => {
    expect(parseMoneyCents('1000000.01', '.')).toBeNull()
    expect(parseMoneyCents('1000000', '.')).toBe(100_000_000)
  })
})

describe('parseImportDay', () => {
  it('reads the format of the profile and only a day that exists', () => {
    expect(parseImportDay('2026-11-12', RemittanceDateFormats.ISO)).toBe('2026-11-12')
    expect(parseImportDay('12/11/2026', RemittanceDateFormats.DAY_FIRST_SLASH)).toBe('2026-11-12')
    expect(parseImportDay('11/12/2026', RemittanceDateFormats.MONTH_FIRST_SLASH)).toBe('2026-11-12')
    expect(parseImportDay('12-11-2026', RemittanceDateFormats.DAY_FIRST_DASH)).toBe('2026-11-12')
    expect(parseImportDay('31/02/2026', RemittanceDateFormats.DAY_FIRST_SLASH)).toBeNull()
    expect(parseImportDay('2026-13-01', RemittanceDateFormats.ISO)).toBeNull()
    expect(parseImportDay('12/11/2026', RemittanceDateFormats.ISO)).toBeNull()
    expect(parseImportDay('', RemittanceDateFormats.ISO)).toBeNull()
  })
})

describe('parseRemittanceFile', () => {
  it('reads the lines of a file by the names of its headers, in any column order', () => {
    const result = parseRemittanceFile(
      'Fecha,Monto,Guia\n2026-11-12,10.50,G-1\n2026-11-12,7,G-2\n',
      profile({
        columns: { guideNumber: 'guia', amount: ' MONTO ', date: 'Fecha' }
      })
    )
    expect(result.errorCount).toBe(0)
    expect(result.lines).toEqual([
      { guideNumber: 'G-1', reportedCents: 1050, row: 2 },
      { guideNumber: 'G-2', reportedCents: 700, row: 3 }
    ])
    expect(result.headers).toEqual(['Fecha', 'Monto', 'Guia'])
    expect(result.rowCount).toBe(2)
    expect(result.receivedOn).toBe('2026-11-12')
  })

  it('reads a file with no header by the position of the columns, with a fee, a reference and ; and a decimal comma', () => {
    const result = parseRemittanceFile(
      'G-1;10,50;1,25;LIQ-9\nG-2;7;;LIQ-9\n',
      profile({
        delimiter: RemittanceDelimiters.SEMICOLON,
        hasHeader: false,
        decimalSeparator: RemittanceDecimalSeparators.COMMA,
        columns: { guideNumber: 0, amount: 1, fee: 2, reference: 3 }
      })
    )
    expect(result.errorCount).toBe(0)
    expect(result.lines).toEqual([
      { guideNumber: 'G-1', reportedCents: 1050, reportedFeeCents: 125, row: 1 },
      { guideNumber: 'G-2', reportedCents: 700, row: 2 }
    ])
    expect(result.reference).toBe('LIQ-9')
    expect(result.receivedOn).toBeNull()
  })

  it('reads a table pasted with tabs', () => {
    const result = parseRemittanceFile(
      'Guia\tMonto\nG-1\t5.00\n',
      profile({ delimiter: RemittanceDelimiters.TAB })
    )
    expect(result.lines).toEqual([{ guideNumber: 'G-1', reportedCents: 500, row: 2 }])
  })

  it('reports a cell that is not what its column says, with its row and column, and reads none of the bad rows', () => {
    const result = parseRemittanceFile(
      'Guia,Monto,Fecha\nG-1,abc,2026-11-12\nG-2,5.00,31/02/2026\nG-3,5.00,2026-11-12\n,5.00,\nG-5,,\n',
      profile({
        columns: { guideNumber: 'Guia', amount: 'Monto', date: 'Fecha' }
      })
    )
    expect(result.lines.map(line => line.guideNumber)).toEqual(['G-3'])
    expect(result.errors).toEqual([
      { row: 2, field: 'amount', code: RemittanceImportErrors.INVALID_AMOUNT, value: 'abc' },
      { row: 3, field: 'date', code: RemittanceImportErrors.INVALID_DATE, value: '31/02/2026' },
      { row: 5, field: 'guideNumber', code: RemittanceImportErrors.EMPTY_VALUE, value: null },
      { row: 6, field: 'amount', code: RemittanceImportErrors.EMPTY_VALUE, value: null }
    ])
    expect(result.errorCount).toBe(4)
  })

  it('refuses a cell with a control or invisible character and never evaluates a formula', () => {
    const result = parseRemittanceFile('Guia,Monto\n"G​1",5\n=SUM(A1:A2),5\n"G\t3",5\n', profile())
    expect(result.errors.map(error => [error.row, error.code])).toEqual([
      [2, RemittanceImportErrors.INVALID_TEXT],
      [4, RemittanceImportErrors.INVALID_TEXT]
    ])
    // The formula is only text: it is a guide number that matches no shipment
    expect(result.lines).toEqual([{ guideNumber: '=SUM(A1:A2)', reportedCents: 500, row: 3 }])
  })

  it('names a column that is not in the file instead of reading a different one', () => {
    const result = parseRemittanceFile('A,B\n1,2\n', profile())
    expect(result.errors.map(error => [error.field, error.code])).toEqual([
      ['guideNumber', RemittanceImportErrors.COLUMN_NOT_FOUND],
      ['amount', RemittanceImportErrors.COLUMN_NOT_FOUND]
    ])
    expect(result.lines).toEqual([])
    const byPosition = parseRemittanceFile(
      'G-1,5\n',
      profile({ hasHeader: false, columns: { guideNumber: 0, amount: 5 } })
    )
    expect(byPosition.errors[0]).toMatchObject({
      field: 'amount',
      code: RemittanceImportErrors.COLUMN_NOT_FOUND
    })
  })

  it('says a row is short of a cell', () => {
    const result = parseRemittanceFile('Guia,Monto\nG-1\n', profile())
    expect(result.errors).toEqual([
      { row: 2, field: 'amount', code: RemittanceImportErrors.MISSING_CELL, value: null }
    ])
  })

  it('numbers the rows by the line of the file where they start, also after a quoted cell with line breaks', () => {
    const result = parseRemittanceFile(
      'Guia,Monto,Nota\nG-1,5,"first\nsecond\r\nthird"\nG-2,abc,x\n',
      profile({ columns: { guideNumber: 'Guia', amount: 'Monto' } })
    )
    expect(result.lines).toEqual([{ guideNumber: 'G-1', reportedCents: 500, row: 2 }])
    expect(result.errors).toEqual([
      { row: 5, field: 'amount', code: RemittanceImportErrors.INVALID_AMOUNT, value: 'abc' }
    ])
  })

  it('refuses a row with more cells than the header has instead of reading shifted columns', () => {
    const result = parseRemittanceFile('Guia,Monto\nG-1,5\nG,2,50\n', profile())
    expect(result.lines.map(line => line.guideNumber)).toEqual(['G-1'])
    expect(result.errors).toEqual([
      { row: 3, field: null, code: RemittanceImportErrors.ROW_TOO_WIDE, value: '3' }
    ])
  })

  it('matches a header as it was saved: accents composed or not, one space between words, any case', () => {
    const composed = 'N\u00FAmero de gu\u00EDa'
    const decomposed = 'Nu\u0301mero\u00A0de  gui\u0301a'
    const result = parseRemittanceFile(
      `${decomposed},Monto\nG-1,5\n`,
      profile({
        columns: { guideNumber: composed.toUpperCase(), amount: 'Monto' }
      })
    )
    expect(result.errorCount).toBe(0)
    expect(result.lines).toHaveLength(1)
  })

  it('keeps a guide as one string whichever way it came: NFC and one space between words', () => {
    const result = parseRemittanceFile('Guia,Monto\n"AB  1\u00A02",5\n"Cafe\u0301",5\n', profile())
    expect(result.lines.map(line => line.guideNumber)).toEqual(['AB 1 2', 'Caf\u00E9'])
  })

  it('tolerates empty cells past the header (a trailing delimiter) and refuses a filled one', () => {
    const ok = parseRemittanceFile('Guia,Monto\nG-1,5,\nG-2,6,,\n', profile())
    expect(ok.errorCount).toBe(0)
    expect(ok.lines).toHaveLength(2)
    const shifted = parseRemittanceFile('Guia,Monto\nG-1,5,x\n', profile())
    expect(shifted.errors[0]?.code).toBe(RemittanceImportErrors.ROW_TOO_WIDE)
  })

  it('points the open quote at the line where its row starts', () => {
    const result = parseRemittanceFile(
      'Guia,Monto,Nota\nG-1,5,"a\nb\nc"\nG-2,6,"never closed\n',
      profile()
    )
    expect(result.errors).toEqual([
      { row: 5, field: null, code: RemittanceImportErrors.UNCLOSED_QUOTE, value: null }
    ])
  })

  it('refuses a day that Postgres cannot store', () => {
    expect(parseImportDay('0000-01-01', RemittanceDateFormats.ISO)).toBeNull()
    expect(parseImportDay('1969-12-31', RemittanceDateFormats.ISO)).toBeNull()
    expect(parseImportDay('2101-01-01', RemittanceDateFormats.ISO)).toBeNull()
    expect(parseImportDay('1970-01-01', RemittanceDateFormats.ISO)).toBe('1970-01-01')
  })

  it('answers too many rows at once for a file of very many rows, without running out of stack', () => {
    const text = `Guia,Monto\n${'a,1\n'.repeat(300_000)}`
    const result = parseRemittanceFile(text, profile())
    expect(result.errors.map(error => error.code)).toEqual([RemittanceImportErrors.TOO_MANY_ROWS])
    expect(result.lines).toEqual([])
  })

  it('says a file is empty, has only a header or leaves a quote open', () => {
    expect(parseRemittanceFile('', profile()).errors[0]?.code).toBe(
      RemittanceImportErrors.EMPTY_FILE
    )
    expect(parseRemittanceFile('\n\n  \n', profile()).errors[0]?.code).toBe(
      RemittanceImportErrors.EMPTY_FILE
    )
    expect(parseRemittanceFile('Guia,Monto\n', profile()).errors[0]?.code).toBe(
      RemittanceImportErrors.EMPTY_FILE
    )
    expect(parseRemittanceFile('Guia,Monto\n"G-1,5\n', profile()).errors[0]?.code).toBe(
      RemittanceImportErrors.UNCLOSED_QUOTE
    )
  })

  it('counts the empty lines in the row numbers and skips them', () => {
    const result = parseRemittanceFile('Guia,Monto\n\nG-1,5\n,\nG-2,abc\n', profile())
    expect(result.lines).toEqual([{ guideNumber: 'G-1', reportedCents: 500, row: 3 }])
    expect(result.errors).toEqual([
      { row: 5, field: 'amount', code: RemittanceImportErrors.INVALID_AMOUNT, value: 'abc' }
    ])
  })

  it('repeats a bad cell bounded and on one line', () => {
    const long = `x${'y'.repeat(100)}`
    const result = parseRemittanceFile(`Guia,Monto\nG-1,"${long}"\n`, profile())
    expect(result.errors[0]?.value?.length).toBeLessThanOrEqual(41)
  })

  it('reports the first hundred errors and counts them all', () => {
    const rows = Array.from({ length: 150 }, (_, index) => `G-${index},bad`).join('\n')
    const result = parseRemittanceFile(`Guia,Monto\n${rows}\n`, profile())
    expect(result.errors).toHaveLength(100)
    expect(result.errorCount).toBe(150)
  })

  it('refuses a file of more rows than a settlement holds', () => {
    const rows = Array.from({ length: 5001 }, (_, index) => `G-${index},1`).join('\n')
    const result = parseRemittanceFile(`Guia,Monto\n${rows}\n`, profile())
    expect(result.errors.some(error => error.code === RemittanceImportErrors.TOO_MANY_ROWS)).toBe(
      true
    )
  })

  it('reads only the rows asked for, for the preview', () => {
    const result = parseRemittanceFile('Guia,Monto\nG-1,1\nG-2,2\nG-3,3\n', profile(), {
      maxRows: 2
    })
    expect(result.lines.map(line => line.guideNumber)).toEqual(['G-1', 'G-2'])
  })

  it('leaves the reference and the day empty when the rows disagree', () => {
    const result = parseRemittanceFile(
      'Guia,Monto,Ref,Fecha\nG-1,1,A,2026-11-01\nG-2,1,B,2026-11-02\n',
      profile({
        columns: { guideNumber: 'Guia', amount: 'Monto', reference: 'Ref', date: 'Fecha' }
      })
    )
    expect(result.reference).toBeNull()
    expect(result.receivedOn).toBeNull()
  })
})
