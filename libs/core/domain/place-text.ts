import { MessageLimits, MisleadingTextPattern } from './conversation-constants'

// The shared pattern, and the invisible characters it leaves: the Arabic letter mark, the soft hyphen, the
// Mongolian vowel separator and the tag characters
const MISLEADING_TEXT = new RegExp(
  `${MisleadingTextPattern.source}|[\\u061C\\u00AD\\u180E\\u{E0000}-\\u{E007F}]`,
  'gu'
)

// The name or the address of a place a customer shared, made safe to store and to show: the characters
// that reorder or hide text are taken out, the ends are trimmed, and it is cut to at most `max` UTF-16
// units (the way the core counts) without splitting a character. Null when nothing is left.
export function placeTextOf(
  text: string | undefined | null,
  max: number = MessageLimits.LOCATION_TEXT_MAX_LENGTH
): string | null {
  // A control character (NUL, a line break, DEL) becomes a space: a NUL is refused by the database, and
  // a line break would let a name forge a second line in a preview
  const clean = (text ?? '')
    .replace(MISLEADING_TEXT, '')
    // eslint-disable-next-line no-control-regex -- the point is to remove them
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    // A letter takes a few accents; a hundred stacked on one glyph overflow into the lines around it
    .replace(/(\p{M}{3})\p{M}+/gu, '$1')
    .trim()
  let out = ''
  for (const character of clean) {
    if (out.length + character.length > max) break
    out += character
  }
  const result = out.trim()
  return result === '' ? null : result
}
