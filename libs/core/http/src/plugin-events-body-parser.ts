import type { NextFunction, Request, RequestHandler, Response } from 'express'

import { API_PREFIX, PluginApiRoutes } from '@platform/core/api'
import { PLUGIN_API_KEY_TOKEN_PREFIX, RemoteChannelApiLimits } from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'

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
// the per-address limit of the plugin routes of Step 7.3 is what bounds it (tracked in the plan, PR C4 debt).
// It takes what the other parser takes for this route and nothing more: `application/json` in UTF-8, no content encoding, an
// object or an array. Anything else is left to Nest's parser, which refuses or ignores it as it does everywhere.
export const pluginEventsBodyParser: RequestHandler = (
  request: Request,
  response: Response,
  next: NextFunction
): void => {
  const token = BEARER.exec(request.headers.authorization ?? '')?.[1]
  const encoding = request.headers['content-encoding']
  if (
    request.method !== 'POST' ||
    request.path !== EVENTS_PATH ||
    token === undefined ||
    !token.startsWith(PLUGIN_API_KEY_TOKEN_PREFIX) ||
    !isUtf8Json(request.headers['content-type']) ||
    (encoding !== undefined && encoding.toLowerCase() !== 'identity')
  ) {
    next()
    return
  }
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
