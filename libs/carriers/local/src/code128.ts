// Code 128, subset B (ASCII 32 to 126): enough for a guide number such as JM-000123. Pure: a string in, the
// widths of the bars and spaces out. A renderer draws them; nothing here knows a PDF.

// Bar and space widths of each symbol value 0..102, then the start codes (103 A, 104 B, 105 C), then the stop
const PATTERNS = [
  '212222',
  '222122',
  '222221',
  '121223',
  '121322',
  '131222',
  '122213',
  '122312',
  '132212',
  '221213',
  '221312',
  '231212',
  '112232',
  '122132',
  '122231',
  '113222',
  '123122',
  '123221',
  '223211',
  '221132',
  '221231',
  '213212',
  '223112',
  '312131',
  '311222',
  '321122',
  '321221',
  '312212',
  '322112',
  '322211',
  '212123',
  '212321',
  '232121',
  '111323',
  '131123',
  '131321',
  '112313',
  '132113',
  '132311',
  '211313',
  '231113',
  '231311',
  '112133',
  '112331',
  '132131',
  '113123',
  '113321',
  '133121',
  '313121',
  '211331',
  '231131',
  '213113',
  '213311',
  '213131',
  '311123',
  '311321',
  '331121',
  '312113',
  '312311',
  '332111',
  '314111',
  '221411',
  '431111',
  '111224',
  '111422',
  '121124',
  '121421',
  '141122',
  '141221',
  '112214',
  '112412',
  '122114',
  '122411',
  '142112',
  '142211',
  '241211',
  '221114',
  '413111',
  '241112',
  '134111',
  '111242',
  '121142',
  '121241',
  '114212',
  '124112',
  '124211',
  '411212',
  '421112',
  '421211',
  '212141',
  '214121',
  '412121',
  '111143',
  '111341',
  '131141',
  '114113',
  '114311',
  '411113',
  '411311',
  '113141',
  '114131',
  '311141',
  '411131',
  '211412',
  '211214',
  '211232',
  '2331112'
] as const

const START_B = 104
const STOP = 106
const FIRST_PRINTABLE = 32
const LAST_PRINTABLE = 126
const CHECKSUM_MODULUS = 103

export const Code128 = {
  // The symbols of the table, for the spec that checks it
  PATTERNS,
  START_B,
  STOP,
  // The width of a symbol and of the stop, in modules
  SYMBOL_MODULES: 11,
  STOP_MODULES: 13,
  // The empty space a scanner needs before and after the symbol, in modules
  QUIET_ZONE_MODULES: 10
} as const

export class Code128EncodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Code128EncodeError'
  }
}

// The values of the symbols of `text` in subset B, with the start code in front and the checksum and stop behind
export function code128Values(text: string): number[] {
  if (text.length === 0) throw new Code128EncodeError('Nothing to encode')
  const values: number[] = [START_B]
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code < FIRST_PRINTABLE || code > LAST_PRINTABLE) {
      throw new Code128EncodeError('Only printable ASCII can be encoded')
    }
    values.push(code - FIRST_PRINTABLE)
  }
  // The checksum weights each symbol by its position, the start code counting as position 1
  const sum = values.reduce((total, value, index) => total + value * Math.max(index, 1), 0)
  values.push(sum % CHECKSUM_MODULUS, STOP)
  return values
}

// Alternating bar and space widths in modules, starting with a bar
export function encodeCode128(text: string): number[] {
  return code128Values(text).flatMap(value => {
    const pattern = PATTERNS[value]
    if (pattern === undefined) throw new Code128EncodeError('No symbol for that value')
    return [...pattern].map(Number)
  })
}
