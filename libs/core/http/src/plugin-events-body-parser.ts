import type { NextFunction, Request, RequestHandler, Response } from 'express'

import { API_PREFIX, PluginApiRoutes } from '@platform/core/api'
import { RETRY_AFTER_METADATA_KEY } from '@platform/core/auth'
import { PLUGIN_API_KEY_TOKEN_PREFIX, RemoteChannelApiLimits } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'

import { BodyParserErrorTypes } from './body-parser-error-types'

const EVENTS_PATH = `${API_PREFIX}${PluginApiRoutes.channel.events}`
const BEARER = /^Bearer\s+(\S+)$/i
const JSON_MEDIA_TYPE = 'application/json'
// The charsets of UTF-8 that Nest's parser reads, by any of their names
const UTF8_CHARSET = /^utf-?8$/i

// `application/json`, with or without parameters, and a charset (if it says one) that is UTF-8: what the parser this one sits in
// front of reads for the same route
function isUtf8Json(contentType: string | undefined): boolean {
  if (contentType === undefined) return false
  const [type = '', ...parameters] = contentType.split(';')
  if (type.trim().toLowerCase() !== JSON_MEDIA_TYPE) return false
  return parameters.every(parameter => {
    const [name = '', value = ''] = parameter.split('=')
    return (
      name.trim().toLowerCase() !== 'charset' ||
      UTF8_CHARSET.test(value.trim().replace(/^"|"$/g, ''))
    )
  })
}

// An error in the shape the global filter reads for what Express's own body parser refuses (an http-errors object): the answer
// is the platform's contract, and the body that was sent never reaches the log.
function refusal(status: number, type: string, message: string): Error {
  return Object.assign(new Error(message), { status, type, expose: true })
}

// Reads the body of the request up to `limit` bytes, counting as it arrives: a body that goes past it is refused without reading
// the rest, and a `Content-Length` that already says so is refused before a byte is read.
function readBody(request: Request, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(request.headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) {
      reject(
        refusal(
          HttpStatusCodes.PAYLOAD_TOO_LARGE,
          BodyParserErrorTypes.TOO_LARGE,
          'request entity too large'
        )
      )
      return
    }
    const chunks: Buffer[] = []
    let received = 0
    const done = (): void => {
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('error', onError)
      request.off('aborted', onAborted)
    }
    const onData = (chunk: Buffer): void => {
      received += chunk.length
      if (received > limit) {
        done()
        request.pause()
        reject(
          refusal(
            HttpStatusCodes.PAYLOAD_TOO_LARGE,
            BodyParserErrorTypes.TOO_LARGE,
            'request entity too large'
          )
        )
        return
      }
      chunks.push(chunk)
    }
    const onEnd = (): void => {
      done()
      resolve(Buffer.concat(chunks))
    }
    const onError = (error: Error): void => {
      done()
      reject(error)
    }
    const onAborted = (): void => {
      done()
      reject(refusal(HttpStatusCodes.BAD_REQUEST, BodyParserErrorTypes.ABORTED, 'request aborted'))
    }
    request.on('data', onData)
    request.on('end', onEnd)
    request.on('error', onError)
    request.on('aborted', onAborted)
  })
}

// The body parser of `POST /plugin-api/channel/events` alone (TDD_10 §6.7.5): the 1 MiB that a batch of fifty events may need,
// where every other route of the api keeps the 100 KB of Nest's own parser. It is registered before Nest's parser, which skips a
// request whose body is already read, and it reads a large body only from a caller that carries something shaped like a plugin
// key: the key itself is judged later by its guard. A caller without a header of that shape gets the small parser, but one that
// WRITES the header with a made-up key gets the large one: the cost is one buffer of at most 1 MiB and one JSON parse per request
// before the guard answers 401, ten times what any other route reads. The key cannot be checked here (it is a database lookup), so
// what bounds it is the limit per address of the keys that do not open the door (`PluginKeyProbeLimiter`, Step 7.3 PR S3): an
// address that is over it gets the small parser, so the large body is never read for it, and the guard answers it 429 before it
// looks at the key. The failures are counted after the key is looked up, so a burst of calls that all arrive before the first
// failure is recorded would all read; the reads in flight of one address are capped as well (`EVENTS_CONCURRENT_READS_PER_ADDRESS`),
// which is what bounds the memory of that burst.
// It takes what the other parser takes for this route and nothing more: `application/json` in UTF-8, no content encoding, an
// object or an array. Anything else is left to Nest's parser, which refuses or ignores it as it does everywhere.
function wantsLargeRead(request: Request): boolean {
  const token = BEARER.exec(request.headers.authorization ?? '')?.[1]
  const encoding = request.headers['content-encoding']
  return !(
    request.method !== 'POST' ||
    request.path !== EVENTS_PATH ||
    token === undefined ||
    !token.startsWith(PLUGIN_API_KEY_TOKEN_PREFIX) ||
    !isUtf8Json(request.headers['content-type']) ||
    (encoding !== undefined && encoding.toLowerCase() !== 'identity')
  )
}

function readLargeBody(request: Request, response: Response, next: NextFunction): void {
  readBody(request, RemoteChannelApiLimits.EVENTS_BODY_MAX_BYTES)
    .then(raw => {
      let parsed: unknown
      try {
        parsed = raw.length === 0 ? {} : (JSON.parse(raw.toString('utf8')) as unknown)
      } catch {
        throw refusal(
          HttpStatusCodes.BAD_REQUEST,
          BodyParserErrorTypes.PARSE_FAILED,
          'the body is not valid JSON'
        )
      }
      if (typeof parsed !== 'object' || parsed === null) {
        throw refusal(
          HttpStatusCodes.BAD_REQUEST,
          BodyParserErrorTypes.PARSE_FAILED,
          'the body is not a JSON object'
        )
      }
      request.body = parsed
      // The mark Express's parsers read: the one Nest registers next sees the body is there and goes on
      ;(request as Request & { _body?: boolean })._body = true
      next()
    })
    .catch((error: unknown) => {
      // A body that goes on past the limit is not read to the end: the answer says the connection closes and the request is
      // destroyed once it is sent, so a client that keeps streaming holds no socket
      response.setHeader('Connection', 'close')
      response.once('finish', () => {
        request.destroy()
      })
      next(error)
    })
}

// What the parser asks of the limit of the keys that failed: only how long an address has to wait
export interface PluginKeyProbeGate {
  retryAfter: (address: string) => Promise<number>
}

function tooManyRequests(waitSeconds: number): PlatformException {
  return new PlatformException(
    ErrorCodes.RATE_LIMIT_EXCEEDED,
    'too many requests',
    HttpStatusCodes.TOO_MANY_REQUESTS,
    { [RETRY_AFTER_METADATA_KEY]: Math.max(waitSeconds, 1) }
  )
}

// The parser with the limits in front, for the one route and only for a call that would read the large body (the shape is judged
// first, so a call that would not read costs no Redis round trip). An address that has to wait for its failed keys, or that has
// too many large reads in flight, is answered 429 with the time to wait and never gets a 413 for a good batch (a 413 is a verdict
// on the batch, which a plugin would not retry). The limiter never throws (it lets the call through when Redis fails), but the
// answer is guarded anyway: a failed read must not stop the request. The count of reads in flight is per replica, as the memory is.
export function pluginEventsBodyParser(probes?: PluginKeyProbeGate): RequestHandler {
  const inFlight = new Map<string, number>()
  return (request: Request, response: Response, next: NextFunction): void => {
    if (!wantsLargeRead(request)) {
      next()
      return
    }
    const address = request.ip ?? ''
    const start = (): void => {
      // An unknown address (no `request.ip`) has no count of its own: it would be one for everybody
      if (address === '') {
        readLargeBody(request, response, next)
        return
      }
      const current = inFlight.get(address) ?? 0
      if (current >= RemoteChannelApiLimits.EVENTS_CONCURRENT_READS_PER_ADDRESS) {
        next(tooManyRequests(1))
        return
      }
      inFlight.set(address, current + 1)
      response.once('close', () => {
        const left = (inFlight.get(address) ?? 1) - 1
        if (left <= 0) inFlight.delete(address)
        else inFlight.set(address, left)
      })
      readLargeBody(request, response, next)
    }
    if (probes === undefined) {
      start()
      return
    }
    probes.retryAfter(address).then(wait => {
      if (wait > 0) next(tooManyRequests(wait))
      else start()
    }, start)
  }
}
