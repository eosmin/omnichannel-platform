import type { Server } from 'node:http'

import { HttpServerTimeouts } from '@platform/core/api'

// Sets on the http server the limits that Node leaves at its defaults, so that they are ours and visible (HttpServerTimeouts)
export function applyServerTimeouts(
  server: Pick<Server, 'requestTimeout' | 'headersTimeout'>
): void {
  server.requestTimeout = HttpServerTimeouts.REQUEST_MS
  server.headersTimeout = HttpServerTimeouts.HEADERS_MS
}
