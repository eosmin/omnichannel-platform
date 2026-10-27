import { type NestApplicationOptions, type Type } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import * as Sentry from '@sentry/nestjs'

import { env } from '@platform/core/config/env'

import { configureHttpApp } from './configure-http-app'

export interface HttpAppOptions extends Pick<NestApplicationOptions, 'rawBody'> {
  // Runs once the app is created and before it is configured and started: for what has to be set
  // before the modules initialize, like the adapter of the websockets
  beforeInit?: (app: NestExpressApplication) => void
}

export async function startHttpApp(
  rootModule: Type<unknown>,
  { beforeInit, ...options }: HttpAppOptions = {}
): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(rootModule, {
    ...options,
    bufferLogs: true
  })
  // How many proxies in front of the api to believe about the client IP: the rate limits count per IP
  app.set('trust proxy', env.TRUST_PROXY_HOPS)
  beforeInit?.(app)
  await configureHttpApp(app)
  app.enableShutdownHooks()
  await app.listen(env.PORT)
}

const FLUSH_TIMEOUT_MS = 2000

// What main.ts calls. A failure to start (a bad DATABASE_URL, a port in use) happens before the
// logger exists, so it is reported to Sentry, written to stderr as a JSON line and ends the
// process with a failure code, instead of leaving an unhandled rejection.
export async function runHttpApp(
  rootModule: Type<unknown>,
  options: HttpAppOptions = {}
): Promise<void> {
  try {
    await startHttpApp(rootModule, options)
  } catch (error) {
    Sentry.captureException(error)
    await Sentry.flush(FLUSH_TIMEOUT_MS)
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${JSON.stringify({ level: 60, msg: 'startup failed', err: message })}\n`)
    process.exit(1)
  }
}
