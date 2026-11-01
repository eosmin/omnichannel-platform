import { csvCell, csvHeader, csvLine } from './csv'

describe('csv', () => {
  it('writes empty values as nothing', () => {
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
    expect(csvCell(Number.NaN)).toBe('')
  })

  it('quotes what has a comma, a quote or a line break', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('one\ntwo')).toBe('"one\ntwo"')
  })

  it.each(['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx'])('defuses the formula %j', text => {
    expect(csvCell(text).replace(/^"|"$/g, '').startsWith("'")).toBe(true)
  })

  it('does not touch a negative number or a text that only has a dash inside', () => {
    expect(csvCell(-5)).toBe('-5')
    expect(csvCell('a-b')).toBe('a-b')
  })

  it('writes dates as ISO and booleans as words', () => {
    expect(csvCell(new Date('2026-11-01T10:00:00.000Z'))).toBe('2026-11-01T10:00:00.000Z')
    expect(csvCell(true)).toBe('true')
  })

  it('ends a line with CRLF and starts a file with the BOM', () => {
    expect(csvLine(['a', 1])).toBe('a,1\r\n')
    expect(csvHeader(['x'])).toBe('﻿x\r\n')
  })
})
