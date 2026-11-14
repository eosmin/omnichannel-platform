// Failures of a connection to a link that came from outside that asking again does not change: the certificate of the host does
// not fit its name or does not chain to a root we trust, or the name does not exist. A refused or reset connection, a timeout and a
// DNS server that did not answer may pass. One list for every pinned request of the platform (media links, webhooks).
export const PERMANENT_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ENOTFOUND',
  'ENODATA'
])

// The code of a Node error ('ECONNRESET'), or 'unknown'
export const errorCodeOf = (error: unknown): string =>
  typeof (error as { code?: unknown } | null)?.code === 'string'
    ? (error as { code: string }).code
    : 'unknown'
