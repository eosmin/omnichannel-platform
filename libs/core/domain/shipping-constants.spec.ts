import {
  formatLocalGuideNumber,
  LabelFormat,
  LabelPageSizesMm,
  LocalGuide
} from './shipping-constants'

describe('the guide of the local carrier', () => {
  it('is the prefix, a dash and the sequence padded to six digits', () => {
    expect(formatLocalGuideNumber('JM', 123)).toBe('JM-000123')
    expect(formatLocalGuideNumber('JM', 1)).toBe('JM-000001')
  })

  it('grows past six digits instead of wrapping', () => {
    expect(formatLocalGuideNumber('JM', 1_234_567)).toBe('JM-1234567')
  })

  it('sorts as text up to 999,999 guides of a connection, and the number grows after that', () => {
    const guides = [9, 10, 100, 99_999, 999_999].map(n => formatLocalGuideNumber('JM', n))
    expect([...guides].sort()).toEqual(guides)
    // The seventh digit is a limit of the text order, not of the guide: it stays unique
    expect(formatLocalGuideNumber('JM', 1_000_000)).toBe('JM-1000000')
  })

  it('accepts a short upper-case prefix and nothing else', () => {
    for (const ok of ['J', 'JM', 'A1', 'ABCDEF'])
      expect(LocalGuide.PREFIX_PATTERN.test(ok)).toBe(true)
    for (const bad of ['', 'jm', 'J-M', 'J M', 'ABCDEFG', 'Ñ']) {
      expect(LocalGuide.PREFIX_PATTERN.test(bad)).toBe(false)
    }
  })
})

describe('formatLocalGuideNumber refuses what is not a guide', () => {
  it.each([
    ['a lowercase prefix', 'jm', 1],
    ['a long prefix', 'TOOLONG1', 1],
    ['an empty prefix', '', 1],
    ['a zero sequence', 'JM', 0],
    ['a negative sequence', 'JM', -1],
    ['a fractional sequence', 'JM', 0.5],
    ['not a number', 'JM', Number.NaN],
    ['infinity', 'JM', Number.POSITIVE_INFINITY]
  ])('%s', (_label, prefix, sequence) => {
    expect(() => formatLocalGuideNumber(prefix, sequence)).toThrow()
  })
})

describe('the page of each label format', () => {
  it('has a size for every format', () => {
    for (const format of Object.values(LabelFormat)) {
      expect(LabelPageSizesMm[format].widthMm).toBeGreaterThan(0)
      expect(LabelPageSizesMm[format].heightMm).toBeGreaterThan(LabelPageSizesMm[format].widthMm)
    }
  })

  it('is the 4x6 inch roll for the default format', () => {
    expect(LabelPageSizesMm[LabelFormat.PDF_100X150]).toEqual({ widthMm: 100, heightMm: 150 })
  })
})
