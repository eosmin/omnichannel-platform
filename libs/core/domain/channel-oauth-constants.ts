// "Connect with the provider's login" (Step 7.8): the provider's own login in place of a token pasted by hand. The
// core owns the state, the code exchange and the encryption; a plugin only knows its provider (see
// `ChannelPlugin.oauth` in the SDK).

// How the credentials of a connection were obtained, kept in `ChannelConnection.metadata.authMethod` so
// that support knows which connections are worth moving to the login and nothing else reads it. Only the
// login writes it (`facebook_login`, the value of the rows already stored: it is data, not a name to change); a connection with none was made with what the person pasted or typed,
// which is `manual_token` for whoever reads it
export const ChannelAuthMethods = {
  MANUAL_TOKEN: 'manual_token',
  PROVIDER_LOGIN: 'facebook_login'
} as const

export type ChannelAuthMethod = (typeof ChannelAuthMethods)[keyof typeof ChannelAuthMethods]

// The login flows a plugin may declare. One per SEQUENCE the core runs, so that a new sequence is a new value:
// this one sends the person to the provider's dialog, exchanges the code on the server, lists the accounts
// the person may connect (pages, portfolios) and finishes with the credential of the one they pick.
export const ChannelOAuthKinds = {
  AUTHORIZATION_CODE_WITH_ASSETS: 'authorization-code-with-assets'
} as const

export type ChannelOAuthKind = (typeof ChannelOAuthKinds)[keyof typeof ChannelOAuthKinds]

// What the core keeps while a person is in the provider's dialog, and after, until they pick the account.
// Both live in Redis only, never in the database.
export const ChannelOAuthLimits = {
  // The `state` and the id of the session are opaque values made of random bytes (256 bits), so that
  // neither can be guessed nor derived from anything
  STATE_BYTES: 32,
  SESSION_ID_BYTES: 32,
  // No provider asks for this many permissions; a longer list is not a login a plugin meant to declare
  MAX_SCOPES: 20,
  // A permission name: lowercase words (digits allowed) joined by single underscores, 64 characters at most;
  // no leading, trailing or doubled underscore
  SCOPE_PATTERN: /^(?=.{1,64}$)[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/,
  // The time the person has to finish the provider's dialog, and then to pick the account. The state is
  // read once and removed, so a second try with the same address fails whatever the time left.
  STATE_TTL_SECONDS: 10 * 60,
  SESSION_TTL_SECONDS: 15 * 60,
  // The callback is public (the browser comes back from Facebook without our headers), so it is limited
  // per client address like the webhooks are
  CALLBACK_LIMIT_PER_MINUTE: 20,
  CALLBACK_WINDOW_MS: 60_000,
  // The routes that call the provider for a person (listing the Pages, finishing) share the app's own limits
  // with every store, so each person gets a few a minute
  SESSION_LIMIT_PER_MINUTE: 30,
  // The provider calls of the login take longer than one: the exchange is two calls in a row (the code for a
  // short token, that one for a long-lived token) and the list asks about every portfolio of the person
  EXCHANGE_TIMEOUT_MS: 35_000,
  LIST_TIMEOUT_MS: 30_000
} as const

// What the provider may put in `error` when it sends the browser back without a code (RFC 6749 section 4.1.2.1).
// Only `access_denied` is the person saying no; the others are the provider or the app failing.
export const OAuthProviderErrors = {
  ACCESS_DENIED: 'access_denied',
  SERVER_ERROR: 'server_error',
  TEMPORARILY_UNAVAILABLE: 'temporarily_unavailable'
} as const

// The names the provider puts in the query of the address it sends the browser back to, and the ones
// we put on our own redirect to the web app. Constants, because the callback reads them from the outside.
export const ChannelOAuthQuery = {
  CODE: 'code',
  STATE: 'state',
  REDIRECT_URI: 'redirect_uri',
  ERROR: 'error',
  // The web app receives only this: the opaque id of the session, never a token or a code
  SESSION: 'oauth',
  // Or this, when the login did not end in a session: a reason of the closed list, never what Meta said
  FAILURE: 'oauth_error'
} as const
