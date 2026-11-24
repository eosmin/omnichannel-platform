// How long the api waits for a client to send what it announced. Node's own defaults let a connection that promised more
// body than it sent (a Content-Length larger than the body, a chunked body that never ends) hold a socket for about 5 minutes
// (BAN-182, H-12); a slow client costs a socket for as long as it is allowed to.
//
// Every body the api reads itself is small (JSON, a CSV import, a plugin event of at most 1 MiB): files travel to the storage
// by a signed url, never through the api. Two minutes for the whole request is generous for them over a bad mobile link.
export const HttpServerTimeouts = {
  // The whole request, headers and body, from the first byte. Past it the server answers 408 and closes the socket
  REQUEST_MS: 120_000,
  // The headers alone. Node requires it not to exceed REQUEST_MS
  HEADERS_MS: 30_000
} as const
