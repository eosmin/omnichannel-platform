import { ChannelHealthErrors } from '@platform/core/domain'

// What the owner fixes by connecting the channel again with another token: the card offers the button for
// these and for no other failure (a busy or unavailable provider passes by itself)
const NEEDS_NEW_TOKEN: readonly string[] = [
  ChannelHealthErrors.TOKEN_REJECTED,
  ChannelHealthErrors.PERMISSION_MISSING,
  ChannelHealthErrors.OTHER_ACCOUNT,
  ChannelHealthErrors.ACCOUNT_NOT_LINKED,
  ChannelHealthErrors.REQUEST_REJECTED,
  ChannelHealthErrors.CREDENTIALS_UNREADABLE
]

export function needsNewToken(lastError: string): boolean {
  return NEEDS_NEW_TOKEN.includes(lastError)
}
