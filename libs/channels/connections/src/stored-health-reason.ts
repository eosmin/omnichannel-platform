import { ChannelHealthErrors, ChannelHealthLimits } from '@platform/core/domain'

import { providerErrorText } from './provider-text'

// The reason of a connection that is in error, as the owner reads it: what the plugin said, cleaned (tags, credentials,
// hidden characters, size), also for what an earlier version stored. A reason that is nothing once cleaned is no reason:
// the same fallback as the check that writes it. A closed-list code (`token_rejected`) comes out as it went in.
export function storedHealthReason(stored: string | null): string | null {
  if (stored === null) return null
  const reason = providerErrorText(stored, ChannelHealthLimits.ERROR_MAX_LENGTH)
  return reason === '' ? ChannelHealthErrors.UNSPECIFIED : reason
}
