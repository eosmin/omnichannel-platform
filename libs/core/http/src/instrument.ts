import { env } from '@platform/core/config/env'

import { initSentry } from './sentry'

// A separate entry point on purpose: instrument.ts of an app must run before the rest of the
// platform is loaded, and the barrel of this library would load all of it first.
export function initSentryFromEnv(): boolean {
  return initSentry({ dsn: env.SENTRY_DSN, environment: env.NODE_ENV, release: env.COMMIT_SHA })
}
