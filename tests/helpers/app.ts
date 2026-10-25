import type { INestApplication } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'

import { configureHttpApp } from '@platform/core/http'

import { AppModule } from '../../apps/api/src/app.module'
import { TenantProbeController } from '../../apps/api/src/testing/tenant-probe.controller'

// The app of the api as it runs, built from the same AppModule and configured by the same function
// as main.ts: the same guards, pipes, filters, prefix and security headers. The only addition is the
// probe controller, the stand-in for the first tenant resources (see its file); the real ones
// replace it as they arrive.
export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [TenantProbeController]
  }).compile()
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true })
  app.set('trust proxy', 1) // As TRUST_PROXY_HOPS says in helpers/env.ts
  await configureHttpApp(app)
  return app
}
