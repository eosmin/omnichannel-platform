import { getQueueToken } from '@nestjs/bullmq'
import type { INestApplication, Type } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test, type TestingModuleBuilder } from '@nestjs/testing'

import { EventsBridge } from '@platform/core/event-bus'
import { configureHttpApp } from '@platform/core/http'
import { QueueNames } from '@platform/core/queues'

import { AppModule } from '../../apps/api/src/app.module'
import { useRealtime } from '../../apps/api/src/modules/realtime/use-realtime'
import { TenantProbeController } from '../../apps/api/src/testing/tenant-probe.controller'

import { CapturedEmails } from './email'
import { CapturedQueue } from './queue'

// The app of the api as it runs, built from the same AppModule and configured by the same function
// as main.ts: the same guards, pipes, filters, prefix and security headers. Two things differ: the
// probe controller (the routes that prove the guards, see its file) plus the controllers a suite asks
// for, and the email queue, which keeps what it is given instead of sending it.
export async function createTestApp(
  extraControllers: Type[] = [],
  // For the suite that needs a provider of its own, like a shorter interval
  override: (builder: TestingModuleBuilder) => TestingModuleBuilder = builder => builder
): Promise<INestApplication> {
  const builder = Test.createTestingModule({
    imports: [AppModule],
    controllers: [TenantProbeController, ...extraControllers]
  })
    // The emails of a suite are read, not sent: see CapturedEmails
    .overrideProvider(getQueueToken(QueueNames.EMAIL))
    .useValue(new CapturedEmails())
    // A reply is queued for the worker, and no suite wants one that would send it
    .overrideProvider(getQueueToken(QueueNames.OUTBOUND))
    .useValue(new CapturedQueue())
    // A scan is queued for the worker; the suite reads it, and nothing is left in the development queue
    .overrideProvider(getQueueToken(QueueNames.HEAVY_PROCESSING))
    .useValue(new CapturedQueue())
  const moduleRef = await override(builder).compile()
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bufferLogs: true,
    rawBody: true // As main.ts: a webhook signature is checked over the exact bytes
  })
  app.set('trust proxy', 1) // As TRUST_PROXY_HOPS says in helpers/env.ts
  useRealtime(app) // As main.ts does: before the app initializes
  await configureHttpApp(app)
  // Listening once, on the loopback only: supertest otherwise starts the server for each request and
  // closes it when the first one ends, so requests that run at the same time (Promise.all) lose the
  // server under their feet or reach whatever else got the port, which showed up as a request
  // answered with another status than the app gave, or reset, once in a few hundred
  await app.listen(0, '127.0.0.1')
  // The bridge subscribes when its connection is ready, after the boot: an event published right
  // after this returns would otherwise go to nobody
  await app.get(EventsBridge, { strict: false }).subscribed
  return app
}
