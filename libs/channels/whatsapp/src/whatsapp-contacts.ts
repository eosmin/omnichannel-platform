import {
  type ContactCard,
  ContactCardLimits,
  InboundLimits,
  placeTextOf
} from '@platform/core/domain'

import { whatsAppContactCardSchema, type WhatsAppContactCard } from './whatsapp-webhook.schema'

// What a customer shares from the address book of their phone, in the shape the core keeps. The text of
// a card is the customer's (or of someone the customer copied it from): it is cleaned of what hides or
// reorders text and cut. The caps on the number of cards, phones and emails come from the domain, and
// the whole list must fit the metadata of a message: the core refuses an event whose metadata is too
// big and Meta does not send it again, so what does not fit is left out and the message is kept.

function nameOf(card: WhatsAppContactCard): string | null {
  const formatted = placeTextOf(card.name?.formatted_name, ContactCardLimits.NAME_MAX_LENGTH)
  if (formatted !== null) return formatted
  const parts = [card.name?.first_name, card.name?.last_name]
    .map(part => placeTextOf(part, ContactCardLimits.NAME_MAX_LENGTH))
    .filter((part): part is string => part !== null)
  return parts.length === 0
    ? null
    : (placeTextOf(parts.join(' '), ContactCardLimits.NAME_MAX_LENGTH) ?? null)
}

function cardOf(raw: unknown): ContactCard | null {
  const parsed = whatsAppContactCardSchema.safeParse(raw)
  if (!parsed.success) return null
  const name = nameOf(parsed.data)
  const phones = parsed.data.phones
    .flatMap(phone => {
      const number = placeTextOf(phone.phone ?? phone.wa_id, ContactCardLimits.PHONE_MAX_LENGTH)
      const kind = placeTextOf(phone.type, ContactCardLimits.KIND_MAX_LENGTH)
      return number === null ? [] : [{ number, ...(kind === null ? {} : { kind }) }]
    })
    .slice(0, ContactCardLimits.MAX_PHONES)
  const emails = parsed.data.emails
    .flatMap(email => {
      const address = placeTextOf(email.email, ContactCardLimits.EMAIL_MAX_LENGTH)
      const kind = placeTextOf(email.type, ContactCardLimits.KIND_MAX_LENGTH)
      return address === null ? [] : [{ address, ...(kind === null ? {} : { kind }) }]
    })
    .slice(0, ContactCardLimits.MAX_EMAILS)
  // A card with no name and nothing to reach is not a contact
  if (name === null && phones.length === 0 && emails.length === 0) return null
  return { name: name ?? phones[0]?.number ?? emails[0]?.address ?? '', phones, emails }
}

// The cards that fit: at most MAX_CONTACTS, and as many as keep the metadata under its byte cap (the
// key that holds them counts)
export function contactCardsOf(raw: readonly unknown[]): ContactCard[] {
  const cards: ContactCard[] = []
  for (const item of raw) {
    if (cards.length === ContactCardLimits.MAX_CONTACTS) break
    const card = cardOf(item)
    if (card === null) continue
    if (
      Buffer.byteLength(JSON.stringify({ contacts: [...cards, card] })) >
      InboundLimits.METADATA_MAX_BYTES
    ) {
      break
    }
    cards.push(card)
  }
  return cards
}

// The line the thread shows beside the cards (and the preview of the conversation): the names
export function contactsLine(cards: readonly ContactCard[]): string {
  return cards.map(card => card.name).join(', ')
}
