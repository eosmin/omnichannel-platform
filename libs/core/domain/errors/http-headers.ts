// The names of the response headers the platform writes itself, in one place. Names are not case
// sensitive on the wire; Node and the clients that read them lower-case them.
export const HttpHeaders = {
  // How many seconds to wait: the same value as `retryAfterSeconds` of the body of a 429 or a 503
  RETRY_AFTER: 'Retry-After'
} as const
