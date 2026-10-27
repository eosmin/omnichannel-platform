import { type Readable, Transform } from 'node:stream'

import { graphUnexpected, graphUnreachable } from './graph-failure'

// Passes the bytes through and fails the stream as soon as more than `max` have gone by. When the
// size is known (`expected`), a stream that ends short fails as well, so a download cut off by the
// server is not taken for a whole file. What goes wrong at the source (an abort, a timeout) reaches
// the returned stream as a plugin error, and whoever ends the returned stream (the limit, the
// consumer, an error) also closes the response underneath.
export function limitBytes(source: Readable, max: number, expected: number | null): Transform {
  let seen = 0
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, done): void {
      seen += chunk.length
      if (seen > max) done(graphUnexpected())
      else done(null, chunk)
    },
    flush(done): void {
      done(expected !== null && seen !== expected ? graphUnreachable() : null)
    },
    destroy(error, done): void {
      source.destroy()
      done(error)
    }
  })
  source.once('error', () => limit.destroy(graphUnreachable()))
  // A source closed before its end, with no error (an abort, a cancel), would leave the stream waiting
  source.once('close', () => {
    if (!source.readableEnded) limit.destroy(graphUnreachable())
  })
  source.pipe(limit)
  return limit
}
