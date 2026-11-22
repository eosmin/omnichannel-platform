import { createHmac } from 'node:crypto'

import { z } from 'zod'

import { decrypt, encrypt, parseEncryptionKey } from '@platform/core/crypto'
import { DsrType } from '@platform/core/domain'
import { type Locale, SUPPORTED_LOCALES } from '@platform/core/i18n'

// The address as the store compares it with the address of a customer: trimmed and lower case, exact (never a LIKE: "%" and "_" are
// wildcards there). A customer's address is compared the same way (`lower(trim(email))`).
export const normalizeDsrEmail = (email: string): string => email.trim().toLowerCase()

// A keyed hash of the normalized address: the limit per address and the duplicate check read this, never the address
export function dsrEmailHash(email: string, key: string): string {
  return createHmac('sha256', key).update(normalizeDsrEmail(email)).digest('hex')
}

// Derived from the signing secret with its own label (like the cookie banner's), so no other key is this one
export function dsrHashKeyOf(secret: string): string {
  return createHmac('sha256', secret).update('dsr-email-hash-key:v1').digest('hex')
}

// What the public form sends once it passed the checks of the route; it travels sealed to the worker
export const dsrIntakeSchema = z.object({
  storeKey: z.string().min(16).max(128),
  type: z.enum(DsrType),
  // A pasted address often carries a space or capitals: trimmed and lower-cased first, then checked
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  locale: z.custom<Locale>(value => SUPPORTED_LOCALES.some(locale => locale === value))
})
export type DsrIntake = z.infer<typeof dsrIntakeSchema>

export function sealDsrIntake(intake: DsrIntake, encryptionKeyHex: string): string {
  return encrypt(JSON.stringify(intake), parseEncryptionKey(encryptionKeyHex)).toString('base64')
}

// null: the payload does not open or does not fit (a tampered or an old job): the worker drops it without a retry
export function openDsrIntake(sealed: string, encryptionKeyHex: string): DsrIntake | null {
  try {
    const text = decrypt(Buffer.from(sealed, 'base64'), parseEncryptionKey(encryptionKeyHex))
    const parsed = dsrIntakeSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

// The address a request will be answered at, from its sealed column. null when it does not open (a key that changed, a damaged value): the
// caller closes the request without a mail instead of being unable to close it at all
export function openDsrNotifyAddress(sealed: Uint8Array, encryptionKeyHex: string): string | null {
  try {
    return decrypt(Buffer.from(sealed), parseEncryptionKey(encryptionKeyHex))
  } catch {
    return null
  }
}
