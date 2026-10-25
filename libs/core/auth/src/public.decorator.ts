import { applyDecorators, SetMetadata } from '@nestjs/common'

export const IS_PUBLIC_KEY = 'isPublic'

// The AuthGuard is global: every route needs a valid access token unless it says otherwise. The
// public ones are the probes, the metrics, the webhooks and the routes that start a session.
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true)

export const OPTIONAL_SESSION_KEY = 'optionalSession'

// Public, and if the request carries a bearer token it is checked like any other (an expired or
// forged one is refused, not taken for anonymous) and the user is put on the request. For the one
// kind of route that behaves differently for someone logged in: accepting an invitation.
export const OptionalSession = (): MethodDecorator & ClassDecorator =>
  applyDecorators(Public(), SetMetadata(OPTIONAL_SESSION_KEY, true))
