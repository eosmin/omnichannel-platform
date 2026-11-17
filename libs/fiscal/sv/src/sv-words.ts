// The amount of a document in words (the field `totalLetras`): capitals, the dollars in words and the cents as a fraction of 100,
// "CIENTO VEINTITRÉS 45/100 DÓLARES". Up to 999,999,999 dollars (the field of the authority is 200 characters).

const UNITS = [
  'CERO',
  'UNO',
  'DOS',
  'TRES',
  'CUATRO',
  'CINCO',
  'SEIS',
  'SIETE',
  'OCHO',
  'NUEVE',
  'DIEZ',
  'ONCE',
  'DOCE',
  'TRECE',
  'CATORCE',
  'QUINCE',
  'DIECISÉIS',
  'DIECISIETE',
  'DIECIOCHO',
  'DIECINUEVE',
  'VEINTE',
  'VEINTIUNO',
  'VEINTIDÓS',
  'VEINTITRÉS',
  'VEINTICUATRO',
  'VEINTICINCO',
  'VEINTISÉIS',
  'VEINTISIETE',
  'VEINTIOCHO',
  'VEINTINUEVE'
]
const TENS = [
  '',
  '',
  '',
  'TREINTA',
  'CUARENTA',
  'CINCUENTA',
  'SESENTA',
  'SETENTA',
  'OCHENTA',
  'NOVENTA'
]
const HUNDREDS = [
  '',
  'CIENTO',
  'DOSCIENTOS',
  'TRESCIENTOS',
  'CUATROCIENTOS',
  'QUINIENTOS',
  'SEISCIENTOS',
  'SETECIENTOS',
  'OCHOCIENTOS',
  'NOVECIENTOS'
]

function below100(n: number): string {
  if (n < 30) return UNITS[n] ?? ''
  const tens = TENS[Math.floor(n / 10)] ?? ''
  return n % 10 === 0 ? tens : `${tens} Y ${UNITS[n % 10] ?? ''}`
}

function below1000(n: number): string {
  if (n === 100) return 'CIEN'
  const hundreds = HUNDREDS[Math.floor(n / 100)] ?? ''
  const rest = n % 100
  if (rest === 0) return hundreds
  return hundreds === '' ? below100(rest) : `${hundreds} ${below100(rest)}`
}

// "UNO" ends in "UN" before a noun: "VEINTIÚN MIL", "UN MIL"
const apocope = (words: string): string =>
  words.endsWith('VEINTIUNO')
    ? `${words.slice(0, -'VEINTIUNO'.length)}VEINTIÚN`
    : words.endsWith('UNO')
      ? `${words.slice(0, -'UNO'.length)}UN`
      : words

function wholeInWords(n: number): string {
  if (n < 1000) return below1000(n)
  const millions = Math.floor(n / 1_000_000)
  const thousands = Math.floor((n % 1_000_000) / 1000)
  const rest = n % 1000
  const parts: string[] = []
  if (millions > 0)
    parts.push(millions === 1 ? 'UN MILLÓN' : `${apocope(below1000(millions))} MILLONES`)
  if (thousands > 0) parts.push(thousands === 1 ? 'MIL' : `${apocope(below1000(thousands))} MIL`)
  if (rest > 0) parts.push(below1000(rest))
  return parts.join(' ')
}

export function amountInWords(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0 || cents >= 100_000_000_000)
    throw new RangeError('amount out of range')
  const whole = Math.floor(cents / 100)
  const fraction = String(cents % 100).padStart(2, '0')
  return `${whole === 0 ? 'CERO' : wholeInWords(whole)} ${fraction}/100 DÓLARES`
}
