import type { INestApplication } from '@nestjs/common'
import type { Registry } from '@prometheus-io/client'

import { ApiRoutes } from '@platform/core/api'
import { AuthenticatedUserRateLimit, userRateLimitThrottler } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import { ErrorCodes } from '@platform/core/errors'
import { MetricNames } from '@platform/core/metrics'
import { METRICS_REGISTRY } from '@platform/core/metrics-module'
import { AuthenticatedUserRateLimitGuard } from '@platform/core/throttler'

import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const FORBIDDEN = 403
const TOO_MANY_REQUESTS = 429

// One sample of the text exposition of the registry, by metric name and labels (in whatever order the registry writes them);
// undefined when it is not there
function sampleOf(
  exposition: string,
  name: string,
  labels: Record<string, string>
): number | undefined {
  for (const row of exposition.split('\n')) {
    const match = /^([a-z0-9_]+)(?:\{(.*)\})? (\S+)$/.exec(row)
    if (match === null || match[1] !== name) continue
    const found: Record<string, string | undefined> = {}
    for (const pair of (match[2] ?? '').matchAll(/([a-z_]+)="([^"]*)"/g)) {
      found[pair[1] ?? ''] = pair[2]
    }
    if (Object.entries(labels).every(([key, value]) => found[key] === value)) {
      return Number(match[3])
    }
  }
  return undefined
}

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

    // The metrics the dashboard of the quota reads (the owner fits the quota from them): every counted call observed the share of the
    // budget spent, the refusal counted as a hit, and no label carries the person
    const exposition = await app.get<Registry>(METRICS_REGISTRY).metrics()
    const throttler = userRateLimitThrottler(AuthenticatedUserRateLimit)
    const usage = MetricNames.RATE_LIMIT_BUDGET_USAGE
    const observed = sampleOf(exposition, `${usage}_count`, { throttler })
    expect(observed).toBeGreaterThanOrEqual(AuthenticatedUserRateLimit.limit + 1)
    // The first calls spent a sliver of the budget and the last ones all of it: both ends of the histogram are filled
    expect(sampleOf(exposition, `${usage}_bucket`, { throttler, le: '0.05' })).toBeGreaterThan(0)
    expect(sampleOf(exposition, `${usage}_bucket`, { throttler, le: '0.9' })).toBeLessThan(
      observed ?? 0
    )
    expect(sampleOf(exposition, `${usage}_bucket`, { throttler, le: '+Inf' })).toBe(observed)
    expect(sampleOf(exposition, MetricNames.RATE_LIMIT_HITS, { throttler })).toBeGreaterThanOrEqual(
      1
    )
    expect(exposition).not.toContain(ctx.adminA.id)
    expect(exposition).not.toContain(ctx.adminB.id)
  }, 120_000)
})
