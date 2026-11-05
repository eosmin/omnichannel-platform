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

// What makes a NAME misleading when it is drawn in a row of a list (QA TRX-04). The joiners U+200C and
// U+200D are kept where a script or an emoji needs them (Persian spells with the first, a family emoji is
// built with the second); every other invisible format character and the four blank filler letters go,
// together with the braille blank.
const NAME_INVISIBLE = /(?![\u200C\u200D])[\p{Cf}\u115F\u1160\u3164\uFFA0\u2800]/u
const NAME_INVISIBLE_ALL = new RegExp(NAME_INVISIBLE.source, 'gu')
// A joiner at an end, next to a space or next to another joiner joins nothing and draws nothing
const STRAY_JOINER = /(^|[\s\u200C\u200D])[\u200C\u200D]|[\u200C\u200D](?=$|[\s\u200C\u200D])/u
const STRAY_JOINERS_ALL =
  /(^|\s)[\u200C\u200D]+|[\u200C\u200D]+(?=\s|$)|([\u200C\u200D])[\u200C\u200D]+/gu
// A letter with a pile of combining marks smears over the rows around it (zalgo text)
const MARK_RUN_LENGTH = 5
const MARK_RUN = new RegExp(`\\p{M}{${MARK_RUN_LENGTH},}`, 'u')
const MARK_RUN_ALL = new RegExp(`(\\p{M}{${MARK_RUN_LENGTH - 1}})\\p{M}+`, 'gu')

// True when a name has a line break or other control character, a line or paragraph separator, an
// invisible character, a joiner that joins nothing or a pile of combining marks
export function hasMisleadingCharacters(value: string): boolean {
  return (
    /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value) ||
    NAME_INVISIBLE.test(value) ||
    STRAY_JOINER.test(value) ||
    MARK_RUN.test(value)
  )
}

// A name that a person typed, made one line: every kind of space is a single space, in NFC
export function plainName(value: string): string {
  return value
    .normalize('NFC')
    .replaceAll(/\p{Zs}+/gu, ' ')
    .trim()
}

// The same rules applied by cleaning, for a name a channel reports (the message that carries it must
// still arrive): breaks and spaces become one space, what is invisible goes, the joiners that join
// nothing and the marks over four go. The result is one visible line, or empty.
export function cleanName(raw: string): string {
  return raw
    .replace(LONE_SURROGATE, '')
    .replaceAll('\0', '')
    .replaceAll(NAME_INVISIBLE_ALL, '')
    .replaceAll(/[\p{Cc}\p{Zl}\p{Zp}\p{Zs}]+/gu, ' ')
    .normalize('NFC')
    .replaceAll(MARK_RUN_ALL, '$1')
    .replaceAll(
      STRAY_JOINERS_ALL,
      (_match, edge: string | undefined, kept: string | undefined) => (edge ?? '') + (kept ?? '')
    )
    .trim()
}
