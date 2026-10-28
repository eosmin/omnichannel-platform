// Half of an emoji: a high surrogate with no low one after it, or a low one with no high one before.
// Cutting text by UTF-16 units can leave one, and Postgres and the engine of Prisma reject it.
export const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

// Postgres refuses a NUL in text and in jsonb, and a lone half of an emoji in jsonb. A provider's text
// is not ours to refuse: the NULs go, a lone surrogate becomes U+FFFD, and the rest is kept.
export const safeText = (text: string): string =>
  text.replaceAll('\0', '').replace(LONE_SURROGATE, '\uFFFD')

// An emoji a person left: visible, short, and nothing the database would refuse (a NUL, half of one)
export const isWholeEmoji = (value: string, maxLength: number): boolean =>
  value.trim() !== '' && value.length <= maxLength && safeText(value) === value

// The accents of the Latin and Greek letters: the combining marks that "é" splits into. The marks of
// other scripts (the voicing of a Japanese kana, the vowels of Devanagari) change the word and stay.
const LATIN_ACCENTS = /[̀-ͯ]/g
// The format characters that draw nothing (zero-width space, joiners, soft hyphen, byte order mark)
// and the four filler letters that look blank
const INVISIBLE = /[\p{Cf}ᅟᅠㅤﾠ]/gu

// How text is compared when something looks for a word in it: lower case, with no accents, with no
// invisible character (a zero-width space inside "refund" does not hide it) and with every run of
// blanks (a line break, a double space, a non-breaking space) as one space. A text made only of
// accents and invisible characters is empty once plain.
export function plainText(text: string): string {
  return text
    .normalize('NFD')
    .replaceAll(LATIN_ACCENTS, '')
    .replaceAll(INVISIBLE, '')
    .replaceAll(/\s+/g, ' ')
    .toLowerCase()
}
