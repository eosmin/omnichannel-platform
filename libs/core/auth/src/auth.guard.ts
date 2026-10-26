import { type ExecutionContext, Injectable } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { AuthGuard as PassportAuthGuard } from '@nestjs/passport'

import type { AuthenticatedUser } from '@platform/core/auth'
import { ErrorCodes, HttpStatusCodes, PlatformException, unauthorized } from '@platform/core/errors'

import { IS_PUBLIC_KEY, OPTIONAL_SESSION_KEY } from './public.decorator'

const NO_TOKEN_MESSAGE = 'No auth token'
const BEARER = /^Bearer\s+\S/i

@Injectable()
export class AuthGuard extends PassportAuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super()
  }

  override canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass()
    ])
    if (isPublic === true && !this.looksForASession(context)) return true
    return super.canActivate(context) as Promise<boolean>
  }

  // A public route that takes a session if one comes: only a bearer token is looked at, and then it
  // has to be a good one
  private looksForASession(context: ExecutionContext): boolean {
    const optional = this.reflector.getAllAndOverride<boolean | undefined>(OPTIONAL_SESSION_KEY, [
      context.getHandler(),
      context.getClass()
    ])
    if (optional !== true) return false
    const { headers } = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>()
    const authorization = headers['authorization']
    return typeof authorization === 'string' && BEARER.test(authorization)
  }

  // The error contract names the cause: no token, an expired one, or one that does not verify. The
  // library's own message (which says "invalid signature" or the algorithm) is not shown.
  override handleRequest<TUser = AuthenticatedUser>(
    _error: unknown,
    user: TUser | false,
    info: unknown
  ): TUser {
    if (user !== false && user !== null && user !== undefined) return user
    const cause = info instanceof Error ? info.name : ''
    if (cause === 'TokenExpiredError') {
      throw new PlatformException(
        ErrorCodes.AUTH_TOKEN_EXPIRED,
        'access token expired',
        HttpStatusCodes.UNAUTHORIZED
      )
    }
    // passport-jwt reports a request with no bearer token as a plain Error with this message
    if (info instanceof Error && info.message === NO_TOKEN_MESSAGE) {
      throw unauthorized('no access token')
    }
    throw new PlatformException(
      ErrorCodes.AUTH_TOKEN_INVALID,
      'invalid access token',
      HttpStatusCodes.UNAUTHORIZED
    )
  }
}
