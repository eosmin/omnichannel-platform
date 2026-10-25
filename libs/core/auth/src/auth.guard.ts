import { type ExecutionContext, Injectable } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { AuthGuard as PassportAuthGuard } from '@nestjs/passport'

import type { AuthenticatedUser } from '@platform/core/auth'
import { ErrorCodes, PlatformException } from '@platform/core/errors'

import { IS_PUBLIC_KEY } from './public.decorator'

const UNAUTHORIZED = 401
const NO_TOKEN_MESSAGE = 'No auth token'

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
    if (isPublic === true) return true
    return super.canActivate(context) as Promise<boolean>
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
        UNAUTHORIZED
      )
    }
    // passport-jwt reports a request with no bearer token as a plain Error with this message
    if (info instanceof Error && info.message === NO_TOKEN_MESSAGE) {
      throw new PlatformException(ErrorCodes.AUTH_UNAUTHORIZED, 'no access token', UNAUTHORIZED)
    }
    throw new PlatformException(ErrorCodes.AUTH_TOKEN_INVALID, 'invalid access token', UNAUTHORIZED)
  }
}
