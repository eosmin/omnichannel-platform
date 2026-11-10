import { ChannelOAuthLimits } from '@platform/core/domain'

// The login of Meta's channels, as the Meta library speaks it. Core, api, worker and web do not know it: the
// scopes and the shape of an account id reach the core as the plugin's `oauth` declaration.

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
  // The Pages the person ticked in the dialog of Facebook (`granular_scopes` of `debug_token`): how many are read
  MAX_GRANTED_PAGES: 25,
  ASSET_NAME_MAX_LENGTH: 200,
  // The portfolios asked about at the same time, so that a person with many does not cost a call after another
  OWNED_PAGES_CONCURRENCY: 5,
  // The id of a Page or a portfolio, as the Graph writes it
  ASSET_ID_PATTERN: /^\d{1,32}$/,
  SCOPE_PATTERN: ChannelOAuthLimits.SCOPE_PATTERN,
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

// The permissions whose targets in `granular_scopes` are Pages (the target of `instagram_basic` is an account)
export const MetaGrantedPageScopes: readonly string[] = [
  MetaOAuthScopes.PAGES_SHOW_LIST,
  MetaOAuthScopes.PAGES_MESSAGING,
  MetaOAuthScopes.PAGES_MANAGE_METADATA
]
