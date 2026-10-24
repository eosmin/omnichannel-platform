import { randomUUID } from 'node:crypto'

import type { NextFunction, Response } from 'express'
import { z } from 'zod'

import type { AuthenticatedRequest } from './authenticated-request'

export const CORRELATION_ID_HEADER = 'x-correlation-id'

const uuid = z.uuid()

// Only a well-formed UUID is accepted from the client; anything else is replaced. The id then
// reaches every log line, the Sentry context, the job payloads and the error responses.
export function correlationIdMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const incoming = req.header(CORRELATION_ID_HEADER)
  const correlationId =
    incoming !== undefined && uuid.safeParse(incoming).success ? incoming : randomUUID()

  req.correlationId = correlationId
  res.setHeader(CORRELATION_ID_HEADER, correlationId)
  next()
}
