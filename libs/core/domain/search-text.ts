// An approximation of the fold the database applies to the stored names (`lower(immutable_unaccent(name))`, the rules of
// `unaccent`), for the places that have no database at hand: whether a typed text is anything but combining marks, and
// the hash that groups repeated searches. A comparison with the stored names always uses the text as the database folds
// it (`foldInDatabase`), because `unaccent` rewrites some six hundred characters and this covers the common ones.
//
// Only the combining marks that sit on a Latin letter go (NFD, drop U+0300-036F, back to NFC): a Hangul syllable or a
// kana with a voicing mark must come out as it went in, because `unaccent` leaves it as it is.
const COMBINING_MARKS = /[̀-ͯ]/g

const UNACCENT_LETTERS: Readonly<Record<string, string>> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  ł: 'l',
  đ: 'd',
  ð: 'd',
  ħ: 'h',
  ı: 'i',
  þ: 'th',
  ƒ: 'f'
}
const UNACCENT_LETTER = new RegExp(`[${Object.keys(UNACCENT_LETTERS).join('')}]`, 'g')

export function foldForSearch(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replaceAll(COMBINING_MARKS, '')
    .normalize('NFC')
    .replaceAll(UNACCENT_LETTER, letter => UNACCENT_LETTERS[letter] ?? letter)
}
