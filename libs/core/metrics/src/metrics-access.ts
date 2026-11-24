import { timingSafeEqual, createHash } from 'node:crypto'

// Who may read `GET /metrics` (B5). The figures name routes, queues and processes, so a deployed environment never answers them to anyone
// who has no token: with none configured the route does not exist there. A laptop and a test run keep it open for a local Prometheus.
export const METRICS_ACCESS = 'METRICS_ACCESS'

export type MetricsAccess =
  | { readonly mode: 'open' }
  | { readonly mode: 'closed' }
  | { readonly mode: 'token'; readonly token: string }

export const OPEN_METRICS_ACCESS: MetricsAccess = { mode: 'open' }

export function metricsAccessOf(input: {
  deployed: boolean
  bearerToken: string | undefined
}): MetricsAccess {
  if (input.bearerToken !== undefined) return { mode: 'token', token: input.bearerToken }
  return input.deployed ? { mode: 'closed' } : OPEN_METRICS_ACCESS
}

const digest = (value: string): Buffer => createHash('sha256').update(value).digest()

// The `Authorization` header of a request against the token (the scheme is case-insensitive, RFC 7235). Both sides are hashed first so that the comparison takes the same time whatever
// the length of what was sent.
export function bearerMatches(header: string | undefined, token: string): boolean {
  if (header === undefined) return false
  const match = /^Bearer\s+(.+)$/i.exec(header)
  if (match === null) return false
  return timingSafeEqual(digest(match[1] as string), digest(token))
}
