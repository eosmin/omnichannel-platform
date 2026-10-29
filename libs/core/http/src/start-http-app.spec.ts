import { Module } from '@nestjs/common'
import * as Sentry from '@sentry/nestjs'

import { runHttpApp } from './start-http-app'

// start-http-app reads the validated env when it is imported; the real one needs a full environment
jest.mock('@platform/core/config/env', () => ({
  env: { PORT: 0, TRUST_PROXY_HOPS: 0, FRONTEND_URL: 'https://app.example.com' }
}))
jest.mock('@sentry/nestjs', () => ({ captureException: jest.fn(), flush: jest.fn() }))

// Nest aborts by itself when a provider cannot be built; a lifecycle hook that fails (the database
// does not answer when the app connects to it) is thrown to whoever started the app
class Database {
  onModuleInit(): never {
    throw new Error('DATABASE_URL is not valid')
  }
}

@Module({ providers: [Database] })
class BrokenModule {}

describe('runHttpApp', () => {
  it('reports a failure to start, writes it as a JSON line and ends the process with a failure', async () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true)

    await runHttpApp(BrokenModule)

    expect(Sentry.captureException).toHaveBeenCalledTimes(1)
    expect(Sentry.flush).toHaveBeenCalled()
    // Nest writes its own lines to stderr too: the one of the platform is the JSON line
    const line = stderr.mock.calls
      .map(call => String(call[0]))
      .find(text => text.includes('startup failed'))
    expect(JSON.parse(line ?? '{}')).toMatchObject({
      level: 60,
      msg: 'startup failed',
      err: 'DATABASE_URL is not valid'
    })
    expect(exit).toHaveBeenCalledWith(1)
    exit.mockRestore()
    stderr.mockRestore()
  })
})
