import { bookCsv, bookSha256 } from './finance-books.csv'

describe('the CSV of a legal book', () => {
  const book = {
    header: ['correlative', 'date', 'supplier_name', 'total'],
    rows: [
      [1, '2027-02-03', 'Acme, S.A.', 1130],
      [2, '2027-02-04', '=HYPERLINK("http://x")', 500],
      [3, '2027-02-05', '+cmd', -113],
      [4, '2027-02-06', '@SUM(A1)', 0],
      [5, '2027-02-07', null, 7]
    ]
  } as const

  it('writes the header and one row per source, whole cents as numbers', () => {
    const lines = bookCsv(book).replace(String.fromCharCode(0xfeff), '').split('\r\n')
    expect(lines[0]).toBe('correlative,date,supplier_name,total')
    expect(lines[1]).toBe('1,2027-02-03,"Acme, S.A.",1130')
    expect(lines[5]).toBe('5,2027-02-07,,7')
    expect(lines).toHaveLength(7)
  })

  it('writes a text that starts like a formula as text, and a negative number as a number', () => {
    const csv = bookCsv(book)
    expect(csv).toContain(`'=HYPERLINK`)
    expect(csv).toContain(`'+cmd`)
    expect(csv).toContain(`'@SUM(A1)`)
    expect(csv).toContain(',-113\r\n')
  })

  it('guards a header the organization wrote as well', () => {
    expect(bookCsv({ header: ['=1+1'], rows: [] })).toContain(`'=1+1`)
  })

  it('is the same bytes, and the same digest, every time (the file of a closed month)', () => {
    expect(bookCsv(book)).toBe(bookCsv(book))
    expect(bookSha256(bookCsv(book))).toMatch(/^[0-9a-f]{64}$/)
    expect(bookSha256(bookCsv(book))).toBe(bookSha256(bookCsv(book)))
    expect(bookSha256(bookCsv({ ...book, rows: [...book.rows].reverse() }))).not.toBe(
      bookSha256(bookCsv(book))
    )
  })
})
