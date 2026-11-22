import { json, type NextFunction, type Request, type RequestHandler, type Response } from 'express'

import { API_PREFIX, ApiRoutes } from '@platform/core/api'
import { ErrorCodes, type ErrorResponse, HttpStatusCodes } from '@platform/core/errors'
import type { AuthenticatedRequest } from '@platform/core/logger'

import { BodyParserErrorTypes } from './body-parser-error-types'

// `/api/v1/webhooks/carriers/<id>`: the id is any one segment (a malformed one is answered by the service like a wrong one)
// Express matches a route without regard to case, so this does too: a path written in capitals reaches the same route
const CARRIER_WEBHOOK_PATH = new RegExp(
  `^${API_PREFIX}${ApiRoutes.webhooks.carrier('[^/]+')}/?$`,
  'i'
)
// What Nest's own parser reads
const PARSER_LIMIT = '100kb'

// The body of a carrier webhook is read here, before Nest's parser, so that a body that is not JSON gets the answer of every other
// thing that is wrong with the call: the uniform 401 (a wrong signature, a connection that does not exist, a malformed id). A
// refusal of the parser as a 400 would say, to whoever has no key, that it reached the parser; the uniform answer says nothing. The
// bytes are kept as `rawBody`, which the signature is over, and a body that parses goes on exactly as it did. Only a body that is
// not JSON changes: it is a 401 here, before any row is read. Other refusals of the parser (too large, an encoding we do not
// read) keep their answers.
export function carrierWebhookBodyParser(): RequestHandler {
  const parse = json({
    limit: PARSER_LIMIT,
    verify: (request, _response, raw) => {
      ;(request as Request & { rawBody?: Buffer }).rawBody = raw
    }
  })
  return (request: Request, response: Response, next: NextFunction): void => {
    if (request.method !== 'POST' || !CARRIER_WEBHOOK_PATH.test(request.path)) {
      next()
      return
    }
    parse(request, response, (error?: unknown) => {
      if (isParseFailure(error)) {
        const body: ErrorResponse = {
          error: {
            code: ErrorCodes.CARRIER_WEBHOOK_SIGNATURE_INVALID,
            message: 'invalid signature',
            metadata: {}
          },
          correlationId: (request as AuthenticatedRequest).correlationId
        }
        response.status(HttpStatusCodes.UNAUTHORIZED).json(body)
        return
      }
      next(error)
    })
  }
}

function isParseFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { type?: unknown }).type === BodyParserErrorTypes.PARSE_FAILED
  )
}
