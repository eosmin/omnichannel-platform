// "Connect with Facebook" (Step 7.8): the provider's own login in place of a token pasted by hand. The
// core owns the state, the code exchange and the encryption; a plugin only knows its provider (see
// `ChannelPlugin.oauth` in the SDK).

// How the credentials of a connection were obtained, kept in `ChannelConnection.metadata.authMethod` so
// that support knows which connections are worth moving to the login and nothing else reads it. Only the
// login writes it (`facebook_login`); a connection with none was made with what the person pasted or typed,
// which is `manual_token` for whoever reads it
export const ChannelAuthMethods = {
  MANUAL_TOKEN: 'manual_token',
  FACEBOOK_LOGIN: 'facebook_login'
} as const

export type ChannelAuthMethod = (typeof ChannelAuthMethods)[keyof typeof ChannelAuthMethods]

// The login flows a plugin may declare. One per provider flow, so that a new flow (WhatsApp Embedded
// Signup, Phase 2) is a new value and the core is told which sequence to run.
export const ChannelOAuthKinds = {
  META_FACEBOOK_LOGIN: 'meta-facebook-login'
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

// Meta's login: classic Facebook Login with `response_type=code`, so the token never passes through the
// browser. Measured with the owner's account in the Graph API Explorer (2026-11-06): `me/accounts` answers
// nothing for a Page that belongs to a portfolio, `me/businesses` and `owned_pages` find it, and the token
// of that Page reads the linked Instagram account.
export const MetaOAuth = {
  RESPONSE_TYPE: 'code',
  // The dialog lives on facebook.com, not on the Graph host: `<origin>/<version>/dialog/oauth`
  DIALOG_ORIGIN: 'https://www.facebook.com',
  DIALOG_PATH: 'dialog/oauth',
  // On the Graph host: the code for a token, and the short token for one of about 60 days
  TOKEN_EDGE: 'oauth/access_token',
  GRANT_EXCHANGE: 'fb_exchange_token',
  // What the person has already granted, to tell which box they cleared in the dialog
  EDGE_PERMISSIONS: 'me/permissions',
  PERMISSION_FIELD_NAME: 'permission',
  PERMISSION_FIELD_STATUS: 'status',
  PERMISSION_GRANTED: 'granted',
  // The three ways to find the Pages of a person, in the order they are tried: the Pages they have a
  // role on, the Pages of their portfolios (all of them: a person has several), and a numeric id they type
  EDGE_ACCOUNTS: 'me/accounts',
  EDGE_BUSINESSES: 'me/businesses',
  EDGE_OWNED_PAGES: 'owned_pages',
  BUSINESS_FIELDS: 'id,name',
  // What the list shows of a Page: never its token, which is read once, for the Page that was chosen. The
  // linked Instagram account is asked only by the channel that needs it (it needs `instagram_basic`).
  PAGE_FIELDS: 'id,name',
  PAGE_FIELDS_WITH_INSTAGRAM: 'id,name,instagram_business_account{id,username}',
  // `access_token` is the token OF THE PAGE, the credential a connection keeps
  PAGE_TOKEN_FIELDS: 'id,access_token',
  PAGE_TOKEN_FIELDS_WITH_INSTAGRAM: 'id,access_token,instagram_business_account{id}',
  // A page of a list, and how many portfolios are asked about: no person has near this many, and a larger
  // number would be a call for every one of them
  LIST_LIMIT: '100',
  MAX_BUSINESSES: 25,
  ASSET_NAME_MAX_LENGTH: 200,
  // The portfolios asked about at the same time, so that a person with many does not cost a call after another
  OWNED_PAGES_CONCURRENCY: 5,
  // The id of a Page or a portfolio, as the Graph writes it
  ASSET_ID_PATTERN: /^\d{1,32}$/,
  // A permission name: lowercase words (digits allowed) joined by single underscores, 64 characters at most;
  // no leading, trailing or doubled underscore
  SCOPE_PATTERN: /^(?=.{1,64}$)[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/,
  // The dialog separates scopes with a comma
  SCOPE_SEPARATOR: ','
} as const

// The permissions of the login, by what each is for. `pages_read_engagement` is the one that is easy to
// miss: without it the Page cannot be read by its id (error 100 in the measurement), and the dialog lets
// the person clear it. `business_management` is NOT asked for: measured on 2026-11-07 with an
// administrator of the app (development mode), `me/businesses/<id>/owned_pages` lists a Page that lives in
// a portfolio without it, and a Page the list cannot find is typed by number. Standard Access is enough
// while only the owner and the people with a role on the app use it; for other accounts they need
// Advanced Access (App Review), which is Phase 2.
export const MetaOAuthScopes = {
  PAGES_SHOW_LIST: 'pages_show_list',
  PAGES_MESSAGING: 'pages_messaging',
  PAGES_MANAGE_METADATA: 'pages_manage_metadata',
  PAGES_READ_ENGAGEMENT: 'pages_read_engagement',
  INSTAGRAM_BASIC: 'instagram_basic',
  INSTAGRAM_MANAGE_MESSAGES: 'instagram_manage_messages'
} as const

export type MetaOAuthScope = (typeof MetaOAuthScopes)[keyof typeof MetaOAuthScopes]
