import { createServer } from 'node:http'

import { HttpServerTimeouts } from '@platform/core/api'

import { applyServerTimeouts } from './server-timeouts'

describe('applyServerTimeouts', () => {
  it('sets the limits of ours on the server', () => {
    const server = createServer()
    applyServerTimeouts(server)
    expect(server.requestTimeout).toBe(HttpServerTimeouts.REQUEST_MS)
    expect(server.headersTimeout).toBe(HttpServerTimeouts.HEADERS_MS)
    // Node refuses a headers timeout longer than the request one
    expect(HttpServerTimeouts.HEADERS_MS).toBeLessThanOrEqual(HttpServerTimeouts.REQUEST_MS)
    // And the two are well under the 5 minutes that Node would hold a stalled body for
    expect(HttpServerTimeouts.REQUEST_MS).toBeLessThan(300_000)
  })
})
