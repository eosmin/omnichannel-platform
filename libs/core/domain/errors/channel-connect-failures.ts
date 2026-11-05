import { type PluginCheck, PluginChecks } from './plugin-checks'

// Why connecting a channel failed, in words the owner can act on. A closed list of names that carry no
// value: it travels from the plugin to the person (`metadata.reason` of the refusal and the `lastError`
// of a connection), and only a name of this list is ever believed, so a plugin cannot put text of its
// own on the screen. The texts are in the catalogs of the web app, under the same names.
export const ChannelConnectFailureReasons = {
  // What was pasted is not a token (nothing, too long, spaces, line breaks, other text)
  TOKEN_MALFORMED: 'token_malformed',
  // The provider refused the token: invalid, expired or revoked
  TOKEN_REJECTED: 'token_rejected',
  // The token lacks a permission, or the person lacks the task on the Page or account
  PERMISSION_MISSING: 'permission_missing',
  // The provider refused the request (often a token of a kind that is not the expected one)
  REQUEST_REJECTED: 'request_rejected',
  // The token reaches no account of the channel
  ACCOUNT_NOT_LINKED: 'account_not_linked',
  // The token is of another account than the connected one
  OTHER_ACCOUNT: 'other_account',
  // The provider answered something that is not what its API says
  PROVIDER_ANSWER_UNEXPECTED: 'provider_answer_unexpected',
  SUBSCRIPTION_NOT_CONFIRMED: 'subscription_not_confirmed',
  // Instagram, through the Page: the account the Page links could not be read
  ACCOUNT_UNREADABLE: 'account_unreadable',
  // The Page could not be subscribed to messages (a refusal, a timeout, an outage): the owner tries again, and
  // checks the permissions of the app if it repeats
  SUBSCRIPTION_FAILED: 'subscription_failed',
  // The subscription of the Page could not be checked: trying again is the whole advice
  SUBSCRIPTION_UNREADABLE: 'subscription_unreadable',
  // The provider asks to wait, or did not answer: trying again later is the whole advice
  PROVIDER_BUSY: 'provider_busy',
  PROVIDER_UNAVAILABLE: 'provider_unavailable'
} as const

export type ChannelConnectFailureReason =
  (typeof ChannelConnectFailureReasons)[keyof typeof ChannelConnectFailureReasons]

// Narrows what came from outside the process (a plugin of a third party, the metadata of an answer)
export function isChannelConnectFailureReason(
  value: unknown
): value is ChannelConnectFailureReason {
  // Inside the function: a top-level call would keep this module in every bundle that imports the barrel
  return Object.values<unknown>(ChannelConnectFailureReasons).includes(value)
}

// The reason of a local check of a plugin. One case for each check: a check that is added and has no
// reason does not compile (a switch, and not a table, so that it ships only where it is used).
export function connectReasonOfCheck(check: PluginCheck): ChannelConnectFailureReason {
  switch (check) {
    case PluginChecks.CREDENTIALS_SHAPE:
    case PluginChecks.TOKEN_NOT_HEADER_SAFE:
      return ChannelConnectFailureReasons.TOKEN_MALFORMED
    case PluginChecks.ACCOUNT_ID_NOT_NUMERIC:
    case PluginChecks.ACCOUNT_SHAPE_INVALID:
    case PluginChecks.PAGE_ID_NOT_NUMERIC:
      return ChannelConnectFailureReasons.PROVIDER_ANSWER_UNEXPECTED
    case PluginChecks.ACCOUNT_ID_MISMATCH:
    case PluginChecks.PAGE_ID_MISMATCH:
      return ChannelConnectFailureReasons.OTHER_ACCOUNT
    case PluginChecks.ACCOUNT_NOT_FOUND:
      return ChannelConnectFailureReasons.ACCOUNT_NOT_LINKED
    // The Page's account could not be read, or the Page could not be subscribed: a token of the Page that
    // is right, a permission taken away or a hiccup of Meta all look alike here, and the advice is to try
    // again and then check the token and the permissions. A provider answer that says more (a refused
    // token, a missing permission, a wait) keeps its own reason.
    case PluginChecks.ACCOUNT_READ_FAILED:
      return ChannelConnectFailureReasons.ACCOUNT_UNREADABLE
    case PluginChecks.SUBSCRIBE_FAILED:
      return ChannelConnectFailureReasons.SUBSCRIPTION_FAILED
    case PluginChecks.SUBSCRIPTION_NOT_CONFIRMED:
      return ChannelConnectFailureReasons.SUBSCRIPTION_NOT_CONFIRMED
    // The subscription of the Page is read before it is changed: whichever step of that read failed, the
    // owner can only try again
    case PluginChecks.SUBSCRIPTION_READ_FAILED:
    case PluginChecks.SUBSCRIPTION_SHAPE_INVALID:
    case PluginChecks.SUBSCRIPTION_APP_UNKNOWN:
      return ChannelConnectFailureReasons.SUBSCRIPTION_UNREADABLE
    default: {
      const unhandled: never = check
      // The name is not in the message: it can come from a plugin of a third party
      void unhandled
      throw new Error('a plugin check has no reason')
    }
  }
}
