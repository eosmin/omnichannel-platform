// The names of the response headers the platform writes itself, in one place. Names are not case
// sensitive on the wire; Node and the clients that read them lower-case them.
export const HttpHeaders = {
  // How many seconds to wait: the same value as `retryAfterSeconds` of the body of a 429 or a 503
  RETRY_AFTER: 'Retry-After',
  // What a rate limit tells the client it was refused for: the limit of the window, what is left of it (always 0 on a refusal) and the
  // seconds until it resets
  RATE_LIMIT_LIMIT: 'X-RateLimit-Limit',
  RATE_LIMIT_REMAINING: 'X-RateLimit-Remaining',
  RATE_LIMIT_RESET: 'X-RateLimit-Reset'
} as const
