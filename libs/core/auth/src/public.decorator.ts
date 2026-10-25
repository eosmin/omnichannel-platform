import { SetMetadata } from '@nestjs/common'

export const IS_PUBLIC_KEY = 'isPublic'

// The AuthGuard is global: every route needs a valid access token unless it says otherwise. The
// public ones are the probes, the metrics, the webhooks and the routes that start a session.
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true)
