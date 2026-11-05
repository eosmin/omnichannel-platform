// The local checks a channel plugin makes before or after it talks to the provider. When one fails the
// plugin names it (never the value that failed it), so the log says which check refused a connection
// without holding a token or an id.
export const PluginChecks = {
  CREDENTIALS_SHAPE: 'credentials_shape',
  TOKEN_NOT_HEADER_SAFE: 'token_not_header_safe',
  ACCOUNT_ID_NOT_NUMERIC: 'account_id_not_numeric',
  ACCOUNT_ID_MISMATCH: 'account_id_mismatch',
  // Instagram, unified login: the token reaches no account (or not the connection's own), or several
  // for a new connection, or the account it names is not shaped as Meta documents
  ACCOUNT_NOT_FOUND: 'account_not_found',
  ACCOUNT_AMBIGUOUS: 'account_ambiguous',
  ACCOUNT_SHAPE_INVALID: 'account_shape_invalid',
  SUBSCRIPTION_NOT_CONFIRMED: 'subscription_not_confirmed'
} as const

export type PluginCheck = (typeof PluginChecks)[keyof typeof PluginChecks]
