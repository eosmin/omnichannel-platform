import { InboundLimits } from '@platform/core/domain'

// What the three Meta plugins do to text that comes from a customer before the core sees it. The core
// refuses a whole event for one field that is too long, and Meta does not send it again, so an
// optional field that does not fit is cut or left out instead of costing the customer's message.

// At most `max` UTF-16 units, the way the core counts them, and never half of a character: an emoji
// is two units, so a title of 255 of them is 510 and would cost the whole message if left as it came
export function cut(text: string, max: number): string {
  let out = ''
  for (const character of text) {
    if (out.length + character.length > max) break
    out += character
  }
  return out
}

// A file name is the customer's to choose. Whatever stores it later gets only the last segment, with no
// control characters, quotes or leading dots: no path, no header injection.
export function safeFilename(name: string | undefined): string | null {
  if (!name) return null
  const base = name.split(/[\\/]/).pop() ?? ''
  const clean = base
    // eslint-disable-next-line no-control-regex -- the point is to remove them
    .replace(/[\u0000-\u001f\u007f"]/g, '')
    .replace(/^\.+/, '')
    .trim()
  return clean === '' ? null : cut(clean, InboundLimits.FILENAME_MAX_LENGTH)
}

// The core refuses a text with nothing but blanks
export const hasText = (text: string | undefined): boolean =>
  text !== undefined && text.trim() !== ''

// The id of the message a reply or a reaction points to, if the core would take it
export const replyTarget = (id: string | undefined): string | undefined =>
  id && id.length <= InboundLimits.ID_MAX_LENGTH ? id : undefined
