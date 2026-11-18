import { ChannelHealthErrors, ChannelHealthLimits } from '@platform/core/domain'

import { providerErrorText } from './provider-text'

// The reason of a connection that is in error, as the owner reads it: what the plugin said, cleaned (tags, credentials,
// hidden characters, size), also for what an earlier version stored. A reason that is nothing once cleaned is no reason:
// the same fallback as the check that writes it. A closed-list code (`token_rejected`) comes out as it went in.
const OUR_CODES: readonly string[] = Object.values(ChannelHealthErrors)

// What a plugin said, ready to keep in `lastError`: cleaned, and never equal to one of our codes. A plugin that answers
// `token_rejected` as its text would otherwise pass for us (the agent would read our text for that code and the card would offer
// the reconnect button), so a text that is exactly a code is kept in brackets: the words stay, the spoof does not.
export function pluginHealthReason(text: string): string {
  const reason = providerErrorText(text, ChannelHealthLimits.ERROR_MAX_LENGTH)
  if (reason === '') return ChannelHealthErrors.UNSPECIFIED
  return OUR_CODES.includes(reason) ? `[${reason}]` : reason
}

export function storedHealthReason(stored: string | null): string | null {
  if (stored === null) return null
  const reason = providerErrorText(stored, ChannelHealthLimits.ERROR_MAX_LENGTH)
  return reason === '' ? ChannelHealthErrors.UNSPECIFIED : reason
}
