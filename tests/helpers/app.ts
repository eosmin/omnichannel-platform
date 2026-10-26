import { getQueueToken } from '@nestjs/bullmq'
import type { INestApplication } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'

import { configureHttpApp } from '@platform/core/http'
import { QueueNames } from '@platform/core/queues'

import { AppModule } from '../../apps/api/src/app.module'
import { TenantProbeController } from '../../apps/api/src/testing/tenant-probe.controller'

import { CapturedEmails } from './email'

// The app of the api as it runs, built from the same AppModule and configured by the same function
// as main.ts: the same guards, pipes, filters, prefix and security headers. Two things differ: the
// probe controller, the stand-in for the first tenant resources (see its file; the real ones replace
// it as they arrive), and the email queue, which keeps what it is given instead of sending it.
export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [TenantProbeController]
  })
    // The emails of a suite are read, not sent: see CapturedEmails
    .overrideProvider(getQueueToken(QueueNames.EMAIL))
    .useValue(new CapturedEmails())
    .compile()
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true })
  app.set('trust proxy', 1) // As TRUST_PROXY_HOPS says in helpers/env.ts
  await configureHttpApp(app)
  // Listening once, on the loopback only: supertest otherwise starts the server for each request and
  // closes it when the first one ends, so requests that run at the same time (Promise.all) lose the
  // server under their feet or reach whatever else got the port, which showed up as a request
  // answered with another status than the app gave, or reset, once in a few hundred
  await app.listen(0, '127.0.0.1')
  return app
}
