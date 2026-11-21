import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuthenticatedUserRateLimit } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import { ErrorCodes } from '@platform/core/errors'
import { AuthenticatedUserRateLimitGuard } from '@platform/core/throttler'

import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const FORBIDDEN = 403
const TOO_MANY_REQUESTS = 429

// The general budget of a person through the real app, the real guards in their real order and the Redis storage. The test app
// turns the guard off for the other suites (tests/helpers/app.ts); this one puts it back.
describe('the general rate limit budget of an authenticated person', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp([], builder =>
      builder
        .overrideProvider(AuthenticatedUserRateLimitGuard)
        .useClass(AuthenticatedUserRateLimitGuard)
    )
    ctx = await seedTestContext(owner, app, prefix)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  it('counts the calls the store guard refuses, then refuses the person everywhere, and leaves other people alone', async () => {
    // An Admin of store A asking, with the token of a valid login, for store B: every call is a 403 of TenantGuard
    for (let i = 0; i < AuthenticatedUserRateLimit.limit; i += 1) {
      await api(app, ctx.adminA, ctx.storeB).get(ApiRoutes.settings.apiKeys).expect(FORBIDDEN)
    }

    const refused = await api(app, ctx.adminA, ctx.storeA)
      .get(ApiRoutes.settings.apiKeys)
      .expect(TOO_MANY_REQUESTS)
    expect((refused.body as { error: { code: string } }).error.code).toBe(
      ErrorCodes.RATE_LIMIT_EXCEEDED
    )
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0)

    await api(app, ctx.adminB, ctx.storeB).get(ApiRoutes.settings.apiKeys).expect(OK)
  }, 120_000)
})
