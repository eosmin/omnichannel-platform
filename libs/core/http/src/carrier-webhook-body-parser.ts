import type { NextFunction, Request, RequestHandler, Response } from 'express'

import { API_PREFIX, ApiRoutes } from '@platform/core/api'
import { ErrorCodes, type ErrorResponse, HttpStatusCodes } from '@platform/core/errors'
import type { AuthenticatedRequest } from '@platform/core/logger'

import { isUtf8Json, readBody } from './plugin-events-body-parser'

// `/api/v1/webhooks/carriers/<id>`: the id is any one segment (a malformed one is answered by the service like a wrong one).
// Express matches a route without regard to case, so this does too: a path written in capitals reaches the same route
const CARRIER_WEBHOOK_PATH = new RegExp(
  `^${API_PREFIX}${ApiRoutes.webhooks.carrier('[^/]+')}/?$`,
  'i'
)
// What Nest's own parser reads (100 KB)
const PARSER_LIMIT_BYTES = 102_400

// The body of a carrier webhook is read here, before Nest's parser, so that a body that is not JSON gets the answer of every other
// thing that is wrong with the call: the uniform 401 (a wrong signature, a connection that does not exist, a malformed id). A
// refusal of the parser as a 400 would say, to whoever has no key, that it reached the parser; the uniform answer says nothing. The
// bytes are kept as `rawBody`, which the signature is over, and a body that parses goes on exactly as it did (`_body` tells Nest's
// parser it was read). Only a body that is not JSON changes: it is a 401 here, before any row is read. Other refusals (too large,
// an aborted upload) keep the answer of the global filter, and a body that is not declared as UTF-8 JSON is left to Nest's parser.
export function carrierWebhookBodyParser(): RequestHandler {
  return (request: Request, response: Response, next: NextFunction): void => {
    const encoding = request.headers['content-encoding']
    if (
      request.method !== 'POST' ||
      !CARRIER_WEBHOOK_PATH.test(request.path) ||
      !isUtf8Json(request.headers['content-type']) ||
      (encoding !== undefined && encoding.toLowerCase() !== 'identity')
    ) {
      next()
      return
    }
    const uniform401 = (): void => {
      const body: ErrorResponse = {
        error: {
          code: ErrorCodes.CARRIER_WEBHOOK_SIGNATURE_INVALID,
          message: 'invalid signature',
          metadata: {}
        },
        correlationId: (request as AuthenticatedRequest).correlationId
      }
      response.status(HttpStatusCodes.UNAUTHORIZED).json(body)
    }
    readBody(request, PARSER_LIMIT_BYTES).then(
      raw => {
        let parsed: unknown
        try {
          parsed = raw.length === 0 ? {} : (JSON.parse(raw.toString('utf8')) as unknown)
        } catch {
          uniform401()
          return
        }
        // An object or an array, as the strict parser of Express took: a bare string, number or null is not a body
        if (typeof parsed !== 'object' || parsed === null) {
          uniform401()
          return
        }
        const read = request as Request & { rawBody?: Buffer; _body?: boolean }
        read.rawBody = raw
        read.body = parsed
        read._body = true
        next()
      },
      (error: unknown) => {
        // A body that goes on past the limit is not read to the end: the answer says the connection closes and the request is
        // destroyed once it is sent, so a client that keeps streaming holds no socket
        response.setHeader('Connection', 'close')
        response.once('finish', () => {
          request.destroy()
        })
        next(error)
      }
    )
  }
}
