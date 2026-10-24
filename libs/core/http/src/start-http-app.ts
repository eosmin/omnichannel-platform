import { type NestApplicationOptions, type Type } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import * as Sentry from '@sentry/nestjs'

import { env } from '@platform/core/config/env'

import { configureHttpApp } from './configure-http-app'

export async function startHttpApp(
  rootModule: Type<unknown>,
  options: Pick<NestApplicationOptions, 'rawBody'> = {}
): Promise<void> {
  const app = await NestFactory.create(rootModule, { ...options, bufferLogs: true })
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
  options: Pick<NestApplicationOptions, 'rawBody'> = {}
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
