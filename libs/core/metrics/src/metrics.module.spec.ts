import { Controller, Get, type INestApplication, NotFoundException } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { Counter } from '@prometheus-io/client'

import { MetricNames } from '@platform/core/metrics'

import { MetricDefinitions } from './metric-definitions'
import { InjectMetric } from './metric-tokens'
import { DEFAULT_METRICS_PREFIX, MetricsModule } from './metrics.module'
import { useHttpMetrics } from './use-http-metrics'

@Controller()
class ProbeController {
  constructor(
    @InjectMetric(MetricNames.TENANT_VIOLATIONS) private readonly violations: Counter<string>
  ) {}

  @Get('probe')
  probe(): { ok: true } {
    this.violations.inc({ resource: '/probe' })
    return { ok: true }
  }

  @Get('slow')
  async slow(): Promise<{ done: true }> {
    await new Promise(resolve => setTimeout(resolve, 300))
    return { done: true }
  }

  @Get('items/:id')
  item(): never {
    throw new NotFoundException()
  }
}

describe('MetricDefinitions', () => {
  it('has exactly one definition per metric name', () => {
    expect(Object.keys(MetricDefinitions).sort()).toEqual(Object.values(MetricNames).sort())
  })

  it('gives every histogram buckets and no other kind', () => {
    for (const definition of Object.values(MetricDefinitions)) {
      expect(definition.kind === 'histogram').toBe((definition.buckets?.length ?? 0) > 0)
    }
  })

  it('names every label in snake_case and never uses an id of a single record', () => {
    for (const definition of Object.values(MetricDefinitions)) {
      for (const label of definition.labels) {
        expect(label).toMatch(/^[a-z][a-z_]*$/)
        expect([
          'customer_id',
          'message_id',
          'order_id',
          'user_id',
          'conversation_id'
        ]).not.toContain(label)
      }
    }
  })
})

describe('MetricsModule', () => {
  let app: INestApplication
  let baseUrl: string

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [MetricsModule],
      controllers: [ProbeController]
    }).compile()
    app = module.createNestApplication()
    useHttpMetrics(app)
    await app.listen(0)
    baseUrl = await app.getUrl()
  })

  afterAll(() => app.close())

  async function scrape(): Promise<string> {
    const response = await fetch(`${baseUrl}/metrics`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/plain')
    return response.text()
  }

  it('exposes the process metrics with the platform prefix', async () => {
    expect(await scrape()).toContain(`${DEFAULT_METRICS_PREFIX}process_cpu_user_seconds_total`)
  })

  it('declares every defined metric', async () => {
    const body = await scrape()
    for (const name of Object.values(MetricNames)) expect(body).toContain(`# TYPE ${name} `)
  })

  it('lets a service count through @InjectMetric', async () => {
    await fetch(`${baseUrl}/probe`)
    expect(await scrape()).toContain('platform_tenant_violations_total{resource="/probe"} 1')
  })

  it('counts a request the client gave up on, apart from the ones that finished', async () => {
    await fetch(`${baseUrl}/slow`, { signal: AbortSignal.timeout(50) }).catch(() => undefined)
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(await scrape()).toContain(
      'http_requests_total{method="GET",route="/slow",status_code="aborted"} 1'
    )
  })

  it('counts requests by route pattern, the ones with no route included, and not the scrape itself', async () => {
    await fetch(`${baseUrl}/items/42`)
    await fetch(`${baseUrl}/items/43`)
    await fetch(`${baseUrl}/nowhere`)
    const body = await scrape()
    expect(body).toContain(
      'http_requests_total{method="GET",route="/items/:id",status_code="404"} 2'
    )
    expect(body).toContain(
      'http_requests_total{method="GET",route="unmatched",status_code="404"} 1'
    )
    expect(body).not.toContain('route="/metrics"')
  })
})
