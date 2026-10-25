import type { NextFunction, Request, RequestHandler, Response } from 'express'

import { toAuthenticatedUser } from '@platform/core/auth-module'
import { ErrorCodes, type ErrorCode, type ErrorResponse } from '@platform/core/errors'
import type { AuthenticatedRequest } from '@platform/core/logger'

const BEARER = /^Bearer (\S+)$/i
const UNAUTHORIZED = 401
const FORBIDDEN = 403

export interface BullBoardAccessOptions {
  // Verifies the signature and the expiry, and returns the claims; throws if the token is no good
  verify: (token: string) => Promise<unknown>
  // Lower case; empty means nobody
  adminEmails: readonly string[]
}

function refuse(
  req: Request,
  res: Response,
  status: number,
  code: ErrorCode,
  message: string
): void {
  const body: ErrorResponse = {
    error: { code, message, metadata: {} },
    correlationId: (req as AuthenticatedRequest).correlationId
  }
  res.status(status).json(body)
}

// Bull Board is cross-tenant, so it answers to no store and to no permission: a valid access token
// whose email is on the allowlist. It runs as Express middleware, ahead of Nest, so the global guard
// and the tenant guard never see it. The token travels in the Authorization header only: no cookie,
// so a page on another site cannot ride on the session of an admin (and a browser needs an
// extension that sets the header to open the UI).
export function bullBoardAccess(options: BullBoardAccessOptions): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = BEARER.exec(req.get('authorization') ?? '')?.[1]
    if (token === undefined) {
      return refuse(req, res, UNAUTHORIZED, ErrorCodes.AUTH_UNAUTHORIZED, 'no access token')
    }
    options
      .verify(token)
      .then(payload => {
        const user = toAuthenticatedUser(payload)
        if (user === false) {
          return refuse(
            req,
            res,
            UNAUTHORIZED,
            ErrorCodes.AUTH_TOKEN_INVALID,
            'invalid access token'
          )
        }
        if (!options.adminEmails.includes(user.email.toLowerCase())) {
          return refuse(
            req,
            res,
            FORBIDDEN,
            ErrorCodes.PERMISSION_DENIED,
            'not a queue administrator'
          )
        }
        next()
      })
      .catch((error: unknown) => {
        const expired = error instanceof Error && error.name === 'TokenExpiredError'
        refuse(
          req,
          res,
          UNAUTHORIZED,
          expired ? ErrorCodes.AUTH_TOKEN_EXPIRED : ErrorCodes.AUTH_TOKEN_INVALID,
          expired ? 'access token expired' : 'invalid access token'
        )
      })
  }
}
