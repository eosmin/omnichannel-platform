import { ChannelOAuthLimits, isDialogOrigin } from '@platform/core/domain'
import {
  type ChannelConnectFailureReason,
  ChannelConnectFailureReasons
} from '@platform/core/errors'

// What "Connect with the provider" leaves in the address of the web app when the browser comes back (Step 7.8),
// and what is read of it. The api sends one of two things, and only these: the opaque id of a session
// (`oauth`), or a reason of a closed list (`oauth_error`). Nothing else the provider said reaches here.
const SESSION_PARAM = 'oauth'
const FAILURE_PARAM = 'oauth_error'
// The id of a session is random bytes in base64url, sized by the same constant the api makes it with
const SESSION_PATTERN = new RegExp(
  `^[A-Za-z0-9_-]{${Math.ceil((ChannelOAuthLimits.SESSION_ID_BYTES * 8) / 6)}}$`
)

// The reasons the callback can end a login with. The table is closed: a value that is not here, even one
// that is a reason of the list for something else, is the generic message and never repeated.
const RETURN_REASONS: ReadonlySet<string> = new Set([
  ChannelConnectFailureReasons.OAUTH_CANCELLED,
  ChannelConnectFailureReasons.OAUTH_EXPIRED,
  ChannelConnectFailureReasons.PROVIDER_UNAVAILABLE,
  // The provider asking to wait while the code is traded is a reason the person can act on
  ChannelConnectFailureReasons.PROVIDER_BUSY,
  ChannelConnectFailureReasons.REQUEST_REJECTED,
  ChannelConnectFailureReasons.PROVIDER_ANSWER_UNEXPECTED
])

// What the person is told when the return is not one of the list: nothing of what came is repeated
export const OAUTH_GENERIC_FAILURE = 'generic'
export type OAuthReturnFailure = ChannelConnectFailureReason | typeof OAUTH_GENERIC_FAILURE

export interface OAuthReturn {
  // The session to pick a Page from, only when its shape is the one the api makes
  session: string | null
  failure: OAuthReturnFailure | null
}

// A parameter that appears once: a repeated one is as good as none
function onlyOne(params: URLSearchParams, name: string): string | null {
  const all = params.getAll(name)
  return all.length === 1 ? (all[0] ?? null) : null
}

export function readOAuthReturn(search: string): OAuthReturn {
  const params = new URLSearchParams(search)
  const failureSeen = params.has(FAILURE_PARAM)
  const rawFailure = onlyOne(params, FAILURE_PARAM)
  const failure: OAuthReturnFailure | null = !failureSeen
    ? null
    : rawFailure !== null && RETURN_REASONS.has(rawFailure)
      ? (rawFailure as ChannelConnectFailureReason)
      : OAUTH_GENERIC_FAILURE
  const rawSession = onlyOne(params, SESSION_PARAM)
  const session =
    rawSession !== null && SESSION_PATTERN.test(rawSession) && failure === null ? rawSession : null
  // A session that came and cannot be read (repeated, or not the shape the api makes) is a failure the person
  // is told of, not a return that looks like nothing happened. A reason wins over a session: a login that
  // failed has nothing to pick from.
  const unreadable = params.has(SESSION_PARAM) && session === null && failure === null
  return { session, failure: unreadable ? OAUTH_GENERIC_FAILURE : failure }
}

// The same address without the parameters, for `history.replaceState`: the id of a session must not stay
// in the history, in a bookmark or in a `Referer`
export function withoutOAuthParams(pathname: string, search: string, hash: string): string {
  const params = new URLSearchParams(search)
  params.delete(SESSION_PARAM)
  params.delete(FAILURE_PARAM)
  const rest = params.toString()
  return `${pathname}${rest === '' ? '' : `?${rest}`}${hash}`
}

// The address the api gave for the dialog of the provider. The page goes there only when it is exactly the
// origin the plugin declared for its login (`oauth.dialogOrigin` of its descriptor), over https and with nothing in
// front of the host, so that an answer that was tampered with cannot take the person anywhere else with their
// session in the address. Without a declared origin there is nowhere to go.
export function isOAuthDialogUrl(value: string, dialogOrigin: string | null): boolean {
  if (dialogOrigin === null || !isDialogOrigin(dialogOrigin)) return false
  try {
    const url = new URL(value)
    return url.origin === dialogOrigin && url.username === '' && url.password === ''
  } catch {
    return false
  }
}

// The permissions the person cleared in the dialog, from the metadata of the refusal: only names of the
// shape of a permission, a few at most, so that nothing else can be painted from there
export function missingPermissionsOf(metadata: Record<string, unknown>): string[] {
  const listed = metadata['missingPermissions']
  if (!Array.isArray(listed)) return []
  // Each name once, in the order the api gave them
  const names = new Set(
    (listed as unknown[]).filter(
      (name): name is string =>
        typeof name === 'string' && ChannelOAuthLimits.SCOPE_PATTERN.test(name)
    )
  )
  return [...names].slice(0, ChannelOAuthLimits.MAX_SCOPES)
}
