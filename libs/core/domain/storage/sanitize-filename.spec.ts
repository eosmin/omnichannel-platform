import { sanitizeFilename } from './sanitize-filename'

describe('sanitizeFilename', () => {
  it('keeps letters, digits, dot, underscore and hyphen', () => {
    expect(sanitizeFilename('Report_2026-01.final.pdf')).toBe('Report_2026-01.final.pdf')
  })

  it('turns every run of anything else into one underscore', () => {
    expect(sanitizeFilename('foto de (1).jpg')).toBe('foto_de_1_.jpg')
  })

  it('takes the accents off instead of losing the letter', () => {
    expect(sanitizeFilename('factura_año_é.pdf')).toBe('factura_ano_e.pdf')
    expect(sanitizeFilename('foto de niño (1).jpg')).toBe('foto_de_nino_1_.jpg')
  })

  it.each([
    ['../../etc/passwd', '__.._etc_passwd'],
    ['..\\..\\windows\\system32', '__.._windows_system32'],
    ['a/b\\c', 'a_b_c'],
    ['a\0b.png', 'a_b.png'],
    ['a\r\nb.png', 'a_b.png'],
    ['$(rm -rf).png', '_rm_-rf_.png'],
    ['x; rm -rf /.png', 'x_rm_-rf_.png']
  ])('leaves no path or shell syntax in %j', (input, expected) => {
    const result = sanitizeFilename(input)
    expect(result).toBe(expected)
    expect(result).toMatch(/^[A-Za-z0-9._-]+$/)
    expect(result).not.toContain('/')
  })

  it('never starts with a dot', () => {
    expect(sanitizeFilename('.env')).toBe('_env')
    expect(sanitizeFilename('..')).toBe('file')
    expect(sanitizeFilename('...hidden.txt')).toBe('_hidden.txt')
  })

  it.each(['', '   ', '/', '日本語', '___'])('falls back to a name for %j', input => {
    expect(sanitizeFilename(input)).toBe('file')
  })

  it('cuts a long name to 120 characters and keeps the extension', () => {
    const result = sanitizeFilename(`${'a'.repeat(300)}.pdf`)
    expect(result).toHaveLength(120)
    expect(result.endsWith('.pdf')).toBe(true)
  })

  it('cuts a long name with no extension', () => {
    expect(sanitizeFilename('b'.repeat(300))).toHaveLength(120)
  })

  it('does not keep a very long "extension"', () => {
    const result = sanitizeFilename(`a.${'c'.repeat(300)}`)
    expect(result).toHaveLength(120)
  })
})
