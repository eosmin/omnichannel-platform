import { parsePhoneNumberFromString } from 'libphonenumber-js/max'

import { DEFAULT_PHONE_REGION } from '@platform/core/domain'

export interface NormalizedPhone {
  // International format for people: +503 7123 4567
  display: string
  // E.164 without the plus, what is searched and matched: 50371234567
  digits: string
}

export interface NormalizePhoneOptions {
  // The number comes from a channel, which hands it over with its country code and no plus (the
  // `wa_id` of WhatsApp). A person who types digits with no plus and no country code means a
  // number of the default region: reading those digits as another country's would store the
  // number of a stranger.
  fromChannel?: boolean
}

// Always with the country code: a number typed without one is read in the default region, and a
// number that is not valid there (or anywhere) is refused instead of stored half-understood. Only
// the number is read: text around it and extensions are refused, because a customer's phone is
// what a message is sent to.
export function normalizePhone(
  input: string,
  { fromChannel = false }: NormalizePhoneOptions = {}
): NormalizedPhone | null {
  const text = input.trim()
  const read = { defaultCountry: DEFAULT_PHONE_REGION, extract: false } as const
  const inRegion = parsePhoneNumberFromString(text, read)
  const parsed =
    fromChannel && inRegion?.isValid() !== true && /^\d{8,15}$/.test(text)
      ? parsePhoneNumberFromString(`+${text}`, { extract: false })
      : inRegion
  if (parsed === undefined || !parsed.isValid() || parsed.ext !== undefined) return null
  return { display: parsed.formatInternational(), digits: parsed.number.slice(1) }
}
