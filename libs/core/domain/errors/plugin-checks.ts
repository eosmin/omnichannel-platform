// The local checks a channel plugin makes before or after it talks to the provider. When one fails the
// plugin names it (never the value that failed it), so the log says which check refused a connection
// without holding a token or an id.
export const PluginChecks = {
  CREDENTIALS_SHAPE: 'credentials_shape',
  TOKEN_NOT_HEADER_SAFE: 'token_not_header_safe',
  ACCOUNT_ID_NOT_NUMERIC: 'account_id_not_numeric',
  ACCOUNT_ID_MISMATCH: 'account_id_mismatch',
  SUBSCRIPTION_NOT_CONFIRMED: 'subscription_not_confirmed'
} as const

export type PluginCheck = (typeof PluginChecks)[keyof typeof PluginChecks]
