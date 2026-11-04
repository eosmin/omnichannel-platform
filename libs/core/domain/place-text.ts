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
  const clean = (text ?? '').replace(MISLEADING_TEXT, '').trim()
  let out = ''
  for (const character of clean) {
    if (out.length + character.length > max) break
    out += character
  }
  const result = out.trim()
  return result === '' ? null : result
}
