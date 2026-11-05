// The local checks a channel plugin makes before or after it talks to the provider. When one fails the
// plugin names it (never the value that failed it), so the log says which check refused a connection
// without holding a token or an id.
export const PluginChecks = {
  CREDENTIALS_SHAPE: 'credentials_shape',
  TOKEN_NOT_HEADER_SAFE: 'token_not_header_safe',
  ACCOUNT_ID_NOT_NUMERIC: 'account_id_not_numeric',
  ACCOUNT_ID_MISMATCH: 'account_id_mismatch',
  // Instagram, token of a Page: the Page links no account, or the account it names is not shaped as
  // Meta documents
  ACCOUNT_NOT_FOUND: 'account_not_found',
  ACCOUNT_SHAPE_INVALID: 'account_shape_invalid',
  // The id of the Page the token is of is not digits
  PAGE_ID_NOT_NUMERIC: 'page_id_not_numeric',
  // The token is not of the Page recorded for the connection, or none is recorded
  PAGE_ID_MISMATCH: 'page_id_mismatch',
  // Which call of a connect failed: the read of the account (the token's own node) or the subscription of
  // the app (the POST). It does not say Meta refused: a timeout or a 5xx is named the same, and the numbers of
  // Meta's answer (`providerCode`), when there is one, go with it.
  ACCOUNT_READ_FAILED: 'account_read_failed',
  SUBSCRIBE_FAILED: 'subscribe_failed',
  SUBSCRIPTION_NOT_CONFIRMED: 'subscription_not_confirmed',
  // The subscription is merged with the one the app already has on the Page: the read of it failed, its
  // answer is not shaped as Meta documents, or the app of the token cannot be told. Nothing is
  // subscribed blind.
  SUBSCRIPTION_READ_FAILED: 'subscription_read_failed',
  SUBSCRIPTION_SHAPE_INVALID: 'subscription_shape_invalid',
  SUBSCRIPTION_APP_UNKNOWN: 'subscription_app_unknown'
} as const

export type PluginCheck = (typeof PluginChecks)[keyof typeof PluginChecks]

// Narrows what came from outside the process (a plugin of a third party) to a name of the list. Inside the
// function: a top-level call would keep this module in every bundle that imports the barrel.
export function isPluginCheck(value: unknown): value is PluginCheck {
  return Object.values<unknown>(PluginChecks).includes(value)
}
