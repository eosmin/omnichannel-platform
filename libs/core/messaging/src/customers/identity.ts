import { z } from 'zod'

import { type ChannelId, ChannelIds, CustomerLimits } from '@platform/core/domain'

import { normalizePhone, type NormalizedPhone } from './phone'

export interface ParsedChannelIdentity {
  // The one form that is stored and compared
  identity: string
  // What the handle says about how to reach the person, read once with the handle
  phone?: NormalizedPhone
  email?: string
}

export interface ChannelIdentitySource {
  // The handle comes from the channel itself (a webhook), not from a person typing it
  fromChannel?: boolean
}

// The handle of a customer on a channel. A phone is compared as digits and an address in lower
// case, so that the same person is the same row however the channel spelled the handle. Null when
// the channel could never have produced it, or when it is longer than any handle can be.
export function parseChannelIdentity(
  channelType: ChannelId,
  raw: string,
  { fromChannel = false }: ChannelIdentitySource = {}
): ParsedChannelIdentity | null {
  const text = raw.trim()
  if (text === '' || text.length > CustomerLimits.CHANNEL_IDENTITY_MAX_LENGTH) return null
  // Postgres text cannot hold a NUL character
  if (text.includes('\0')) return null
  switch (channelType) {
    case ChannelIds.WHATSAPP: {
      const phone = normalizePhone(text, { fromChannel })
      return phone === null ? null : { identity: phone.digits, phone }
    }
    case ChannelIds.EMAIL: {
      const address = text.toLowerCase()
      return address.length <= CustomerLimits.EMAIL_MAX_LENGTH &&
        z.email().safeParse(address).success
        ? { identity: address, email: address }
        : null
    }
    default:
      return { identity: text }
  }
}

// The handle of a person typing it (a form): see parseChannelIdentity for the one a channel sends
export function normalizeChannelIdentity(channelType: ChannelId, raw: string): string | null {
  return parseChannelIdentity(channelType, raw)?.identity ?? null
}
