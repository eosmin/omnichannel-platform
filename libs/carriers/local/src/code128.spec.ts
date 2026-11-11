import { Code128, Code128EncodeError, code128Values, encodeCode128 } from './code128'

// Decodes widths back into symbol values, so the table and the encoder are checked against each other
function decode(modules: readonly number[]): number[] {
  const values: number[] = []
  let at = 0
  while (at < modules.length) {
    const size = values.length > 0 && modules.length - at === 7 ? 7 : 6
    const pattern = modules.slice(at, at + size).join('')
    const value = Code128.PATTERNS.indexOf(pattern as (typeof Code128.PATTERNS)[number])
    values.push(value)
    at += size
  }
  return values
}

describe('Code128', () => {
  describe('the symbol table', () => {
    it('has the 103 symbols, the three start codes and the stop', () => {
      expect(Code128.PATTERNS).toHaveLength(107)
    })

    it('draws every symbol in 11 modules and the stop in 13', () => {
      Code128.PATTERNS.forEach((pattern, value) => {
        const total = [...pattern].reduce((sum, width) => sum + Number(width), 0)
        expect(total).toBe(value === Code128.STOP ? Code128.STOP_MODULES : Code128.SYMBOL_MODULES)
      })
    })

    it('draws every symbol as six widths of one to four modules', () => {
      Code128.PATTERNS.slice(0, Code128.STOP).forEach(pattern => {
        expect(pattern).toHaveLength(6)
        // Each width is 1 to 4 modules
        expect([...pattern].every(width => Number(width) >= 1 && Number(width) <= 4)).toBe(true)
      })
    })

    it('gives each symbol a pattern of its own', () => {
      expect(new Set(Code128.PATTERNS).size).toBe(Code128.PATTERNS.length)
    })

    it('matches the symbols of the standard that are known by heart', () => {
      // Subset B: 'space' is 0, 'A' is 33, 'a' is 65; start B is 104 and the stop is 106
      expect(Code128.PATTERNS[0]).toBe('212222')
      expect(Code128.PATTERNS[33]).toBe('111323')
      expect(Code128.PATTERNS[65]).toBe('121124')
      expect(Code128.PATTERNS[Code128.START_B]).toBe('211214')
      expect(Code128.PATTERNS[Code128.STOP]).toBe('2331112')
    })
  })

  describe('code128Values', () => {
    it('puts the start code first and the checksum and the stop last', () => {
      // 'A': start B (104) + 33 * 1 = 137, 137 mod 103 = 34
      expect(code128Values('A')).toEqual([104, 33, 34, 106])
    })

    it('gives the checksum of a known example', () => {
      // The example of the standard, "PJJ123C": the symbols are the same in subsets A and B, and the start code
      // (104 for B, 103 for A) is the only difference. In A the checksum is 54; in B it is 55
      expect(code128Values('PJJ123C').at(-2)).toBe(55)
    })

    it('weights each symbol by its position', () => {
      // 'AB': 104 + 33 * 1 + 34 * 2 = 205, 205 mod 103 = 102
      expect(code128Values('AB')).toEqual([104, 33, 34, 102, 106])
    })

    it('refuses what subset B cannot hold', () => {
      expect(() => code128Values('')).toThrow(Code128EncodeError)
      expect(() => code128Values('ñ')).toThrow(Code128EncodeError)
      expect(() => code128Values('a\nb')).toThrow(Code128EncodeError)
    })
  })

  describe('encodeCode128', () => {
    it('encodes a guide number and decodes back to the same symbols', () => {
      const modules = encodeCode128('JM-000123')
      expect(decode(modules)).toEqual(code128Values('JM-000123'))
    })

    it('is as wide as the symbols say: start, one per character, checksum, stop', () => {
      const modules = encodeCode128('JM-000123')
      const total = modules.reduce((sum, width) => sum + width, 0)
      // 9 characters + start + checksum = 11 symbols of 11 modules, then the stop
      expect(total).toBe(11 * 11 + Code128.STOP_MODULES)
    })

    it('alternates bar and space, so the count of widths is even before the stop', () => {
      // Each 6-width symbol ends on a space; the stop has 7 and ends on a bar
      expect(encodeCode128('X')).toHaveLength(6 * 3 + 7)
    })
  })
})
