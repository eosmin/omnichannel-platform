// Checks a running service the way a load balancer and an operator would: the probes answer, the
// metrics are exposed outside the /api/v1 prefix, and an unknown route returns the error contract.
// Usage: tsx scripts/smoke-http.ts <baseUrl>
import { argv, exit } from 'node:process'

import { API_PREFIX, InfraRoutes } from '@platform/core/api'
import { ErrorCodes } from '@platform/core/errors'
import { MetricNames } from '@platform/core/metrics'

const [baseUrl] = argv.slice(2)
if (baseUrl === undefined) {
  console.error('usage: tsx scripts/smoke-http.ts <baseUrl>')
  exit(2)
}

const STARTUP_TIMEOUT_MS = 30_000
const REQUEST_TIMEOUT_MS = 5_000

function get(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
}

async function waitUntilUp(): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  for (;;) {
    try {
      if ((await get(InfraRoutes.healthLive)).ok) return
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`${baseUrl} did not start within 30 seconds`)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

const problems: string[] = []

async function expectStatus(path: string, status: number): Promise<Response> {
  const response = await get(path)
  if (response.status !== status)
    problems.push(`${path}: expected ${status}, got ${response.status}`)
  return response
}

await waitUntilUp()
await expectStatus(InfraRoutes.healthLive, 200)
await expectStatus(InfraRoutes.healthReady, 200)
const metrics = await expectStatus(InfraRoutes.metrics, 200)
if (!(await metrics.text()).includes(`# TYPE ${MetricNames.HTTP_REQUESTS_TOTAL} `)) {
  problems.push(`${InfraRoutes.metrics}: the platform metrics are missing`)
}
// The infra routes live outside the version prefix
await expectStatus(`${API_PREFIX}${InfraRoutes.metrics}`, 404)

const unknown = await expectStatus(`${API_PREFIX}/unknown`, 404)
const body = (await unknown.json()) as { error?: { code?: string }; correlationId?: string }
if (body.error?.code !== ErrorCodes.RESOURCE_NOT_FOUND)
  problems.push('unknown route: not the error contract')
if (body.correlationId === undefined) problems.push('unknown route: no correlationId')

if (problems.length > 0) {
  console.error(`${baseUrl}\n${problems.join('\n')}`)
  exit(1)
}
console.log(`${baseUrl}: probes, metrics and the error contract are fine`)
