import { createParamDecorator, type ExecutionContext } from '@nestjs/common'

import type { AuthenticatedUser } from '@platform/core/auth'
import { ErrorCodes, PlatformException } from '@platform/core/errors'
import type { AuthenticatedRequest } from '@platform/core/logger'

// The user of the access token. A route that reads it is not @Public, so the guard has put it there;
// the check is for the day someone marks such a route public by mistake.
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>()
    if (user === undefined) {
      throw new PlatformException(ErrorCodes.AUTH_UNAUTHORIZED, 'no authenticated user', 401)
    }
    return user
  }
)
