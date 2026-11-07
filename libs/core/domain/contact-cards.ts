import { type ContactCard, ContactCardLimits } from './message-metadata'
import { placeTextOf } from './place-text'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// The phones or emails of a card: each entry is read alone (one that is not an object, or has no text, is
// dropped) and the cap counts what is left, so blank entries never use up the places of real ones
function valuesOf(
  raw: unknown,
  field: string,
  max: number,
  maxLength: number
): { value: string; kind?: string }[] {
  if (!Array.isArray(raw)) return []
  const values: { value: string; kind?: string }[] = []
  for (const item of raw as unknown[]) {
    if (values.length === max) break
    if (!isRecord(item)) continue
    const value = typeof item[field] === 'string' ? placeTextOf(item[field], maxLength) : null
    if (value === null) continue
    const kind =
      typeof item['kind'] === 'string'
        ? placeTextOf(item['kind'], ContactCardLimits.KIND_MAX_LENGTH)
        : null
    values.push(kind === null ? { value } : { value, kind })
  }
  return values
}

// One shared contact, in the shape the core keeps, from anything a channel (or a column that anyone with the
// database could have written) holds. Text is cleaned of what hides or reorders text and cut, the counts are
// capped, and a part that does not fit is the same as an absent one. A card with no name and nothing to reach
// is not a contact (null); one with no name is named by its first phone or email.
export function sanitizeContactCard(raw: unknown): ContactCard | null {
  if (!isRecord(raw)) return null
  const phones = valuesOf(
    raw['phones'],
    'number',
    ContactCardLimits.MAX_PHONES,
    ContactCardLimits.PHONE_MAX_LENGTH
  ).map(({ value, kind }) => ({ number: value, ...(kind === undefined ? {} : { kind }) }))
  const emails = valuesOf(
    raw['emails'],
    'address',
    ContactCardLimits.MAX_EMAILS,
    ContactCardLimits.EMAIL_MAX_LENGTH
  ).map(({ value, kind }) => ({ address: value, ...(kind === undefined ? {} : { kind }) }))
  const name =
    (typeof raw['name'] === 'string'
      ? placeTextOf(raw['name'], ContactCardLimits.NAME_MAX_LENGTH)
      : null) ??
    phones[0]?.number ??
    emails[0]?.address
  return name === undefined ? null : { name, phones, emails }
}

// The cards of a message: at most `MAX_CONTACTS`, each read alone, so one that does not fit costs only itself
export function sanitizeContactCards(raw: unknown): ContactCard[] {
  if (!Array.isArray(raw)) return []
  const cards: ContactCard[] = []
  for (const item of raw as unknown[]) {
    if (cards.length === ContactCardLimits.MAX_CONTACTS) break
    const card = sanitizeContactCard(item)
    if (card !== null) cards.push(card)
  }
  return cards
}
