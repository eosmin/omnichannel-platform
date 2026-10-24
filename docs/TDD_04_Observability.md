# TDD 04 — Observability

> Part of the Omnichannel Commerce Platform TDD v1.1
> **MVP v1.2:** this file describes the full product. Before implementing from it, read `MVP_TRIM_CHECKLIST.md`;
> where the two disagree, the checklist wins.
> Covers: structured logging, metrics, error tracking, health checks, alerting

---

## 1. Structured logging (Pino)

**Decision: Pino, not Winston.** Lower overhead, JSON-native, better ecosystem for NestJS.
Packages: `nestjs-pino`, `pino-http`, `pino-pretty` (dev) — versions in `TDD_01` §2.4.

### 1.1 Setup

```typescript
// libs/core/logger/logger.module.ts
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino'
import { env } from '@platform/core/config'
import { InfraRoutes } from '@platform/core/api'
import type { AuthenticatedRequest } from '@platform/core/auth'

const IGNORED_PATHS = new Set<string>([InfraRoutes.healthLive, InfraRoutes.healthReady, InfraRoutes.metrics])

@Module({
  imports: [
    PinoLoggerModule.forRoot({
      pinoHttp: {
        level: env.LOG_LEVEL,

        // Human-readable locally, JSON in deployed environments
        transport: env.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { colorize: true, singleLine: false } }
          : undefined,

        // Every log line carries request context automatically
        customProps: (req: AuthenticatedRequest) => ({
          correlationId: req.correlationId,
          userId: req.user?.id,
          staffId: req.staff?.id,
          storeId: req.store?.id,
          organizationId: req.organization?.id,
          impersonationSessionId: req.impersonation?.id,
        }),

        // Never log secrets
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.headers["x-api-key"]',
            'req.body.password',
            'req.body.currentPassword',
            'req.body.newPassword',
            'req.body.token',
            'req.body.refreshToken',
            'req.body.credentials',
            'req.body.credentials.*',
            'res.headers["set-cookie"]',
            '*.apiKey',
            '*.secret',
            '*.accessToken',
          ],
          remove: true
        },

        // Reduce noise from probes and scrapes (these routes live OUTSIDE the /api/v1 prefix)
        autoLogging: {
          ignore: (req) => IGNORED_PATHS.has(req.url ?? '')
        },

        customLogLevel: (req, res, err) => {
          if (res.statusCode >= 500 || err) return 'error'
          if (res.statusCode >= 400) return 'warn'
          return 'info'
        }
      }
    })
  ],
  exports: [PinoLoggerModule]
})
export class LoggerModule {}
```

`AuthenticatedRequest` (`libs/core/auth/request.types.ts`) augments Express `Request` with
`user`, `staff`, `store`, `organization`, `membership`, `permissions`, `accessLevel`,
`impersonation` and `correlationId`; every guard and middleware writes to that type, never
to `any`.

### 1.2 Usage

```typescript
import { PinoLogger, InjectPinoLogger } from 'nestjs-pino'

@Injectable()
export class OrdersService {
  constructor(
    @InjectPinoLogger(OrdersService.name)
    private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
  ) {}

  async create(input: CreateOrderInput, ctx: TenantContext): Promise<Order> {
    // Structured: object first, message second
    this.logger.info({ storeId: ctx.store.id, itemCount: input.items.length }, 'creating order')

    const order = await this.prisma.client.order.create({ data: this.buildOrder(input, ctx) })

    this.logger.info({ orderId: order.id, totalCents: order.totalCents }, 'order created')
    return order
  }
}
```

**Rules:**
- Never `console.log` in application code (scripts and the seed are the only exception, `TDD_14` §6)
- Always pass a context object as the first argument
- Message strings are English, lowercase-start, no trailing period
- Never log full request bodies, PII, or credentials
- Log at boundaries: entering a use case, external call, error

**Production output:**
```json
{"level":30,"time":1756900800000,"correlationId":"550e8400","userId":"usr_1","storeId":"str_a","itemCount":3,"msg":"creating order"}
```

### 1.3 Correlation ID

```typescript
// libs/core/logger/correlation-id.middleware.ts
export const CORRELATION_ID_HEADER = 'x-correlation-id'

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
    const incoming = req.header(CORRELATION_ID_HEADER)
    const correlationId = incoming && isUuid(incoming) ? incoming : randomUUID()

    req.correlationId = correlationId
    res.setHeader(CORRELATION_ID_HEADER, correlationId)
    next()
  }
}
```

Only a well-formed UUID is accepted from the client; anything else is replaced.

The correlation ID propagates to:
- Every log line for the request
- Sentry error context
- Webhook delivery headers
- BullMQ job data (`correlationId` field on every job payload, `TDD_07` §1.3)
- Error responses returned to the client

---

## 2. Metrics (Prometheus)

Client: `@prometheus-io/client` via `@willsoto/nestjs-prometheus` (`TDD_01` §2.4). If the
pinned `@willsoto/nestjs-prometheus` release still depends on the deprecated `prom-client`,
`MetricsModule` wraps `@prometheus-io/client` directly with the same
`makeCounterProvider`/`@InjectMetric` shape — `prom-client` is never added.

### 2.1 Metric definitions

```typescript
// libs/core/metrics/metric-names.ts
export const MetricNames = {
  // HTTP (auto-collected)
  HTTP_REQUESTS_TOTAL: 'http_requests_total',
  HTTP_REQUEST_DURATION: 'http_request_duration_seconds',

  // Business
  CONVERSATIONS_CREATED: 'platform_conversations_created_total',
  CONVERSATIONS_RESOLVED: 'platform_conversations_resolved_total',
  MESSAGES_RECEIVED: 'platform_messages_received_total',
  MESSAGES_SENT: 'platform_messages_sent_total',
  MESSAGE_SEND_DURATION: 'platform_message_send_duration_seconds',
  ORDERS_CREATED: 'platform_orders_created_total',
  ORDER_VALUE: 'platform_order_value_usd',

  // Security
  AUTH_FAILURES: 'platform_auth_failures_total',
  PERMISSION_DENIALS: 'platform_permission_denials_total',
  TENANT_VIOLATIONS: 'platform_tenant_violations_total',     // Any non-zero value is an incident
  RATE_LIMIT_HITS: 'platform_rate_limit_hits_total',

  // Queues
  QUEUE_DEPTH: 'platform_queue_depth',
  QUEUE_PROCESSED: 'platform_queue_processed_total',
  QUEUE_FAILED: 'platform_queue_failed_total',
  QUEUE_PROCESSING_DURATION: 'platform_queue_processing_duration_seconds',

  // Channels
  CHANNEL_WEBHOOK_RECEIVED: 'platform_channel_webhook_received_total',
  CHANNEL_WEBHOOK_REJECTED: 'platform_channel_webhook_rejected_total',
  CHANNEL_API_ERRORS: 'platform_channel_api_errors_total',
  CHANNEL_CONNECTIONS_ACTIVE: 'platform_channel_connections_active',

  // Outbound webhooks & email
  WEBHOOK_DELIVERIES: 'platform_webhook_deliveries_total',
  EMAILS_SENT: 'platform_emails_sent_total',

  // Realtime
  WEBSOCKET_CONNECTIONS: 'platform_websocket_connections',
  WEBSOCKET_EVENTS_EMITTED: 'platform_websocket_events_emitted_total',

  // Cache
  CACHE_HITS: 'platform_cache_hits_total',
  CACHE_MISSES: 'platform_cache_misses_total',

  // Billing
  QUOTA_BLOCKS: 'platform_quota_blocks_total',
  BILLABLE_CONVERSATIONS: 'platform_billable_conversations_total',

  // AI
  AI_REQUESTS: 'platform_ai_requests_total',
  AI_TOKENS_USED: 'platform_ai_tokens_used_total',
  AI_LATENCY: 'platform_ai_latency_seconds',
  AI_CREDITS_SPENT: 'platform_ai_credits_spent_total',

  // Database
  DB_QUERY_DURATION: 'platform_db_query_duration_seconds',
} as const

export type MetricName = typeof MetricNames[keyof typeof MetricNames]
```

### 2.2 Registration

```typescript
// libs/core/metrics/metrics.module.ts
@Module({
  imports: [
    PrometheusModule.register({
      path: InfraRoutes.metrics,                 // '/metrics', excluded from the global prefix (TDD_02 §7)
      defaultMetrics: { enabled: true, config: { prefix: 'platform_' } }
    })
  ],
  providers: [
    makeCounterProvider({
      name: MetricNames.ORDERS_CREATED,
      help: 'Total orders created',
      labelNames: ['store_id', 'status', 'payment_method']
    }),
    makeHistogramProvider({
      name: MetricNames.MESSAGE_SEND_DURATION,
      help: 'Time to send a message through a channel',
      labelNames: ['channel_type', 'message_type'],
      buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10]
    }),
    makeGaugeProvider({
      name: MetricNames.QUEUE_DEPTH,
      help: 'Number of jobs in queue by state',
      labelNames: ['queue', 'state']
    }),
    makeGaugeProvider({
      name: MetricNames.WEBSOCKET_CONNECTIONS,
      help: 'Active WebSocket connections',
      labelNames: ['store_id']
    }),
    makeCounterProvider({
      name: MetricNames.TENANT_VIOLATIONS,
      help: 'Requests that attempted to reach another tenant\'s data',
      labelNames: ['resource']
    }),
    // ... one provider per metric in MetricNames
  ],
  exports: [PrometheusModule]
})
export class MetricsModule {}
```

`/metrics` is reachable only from the internal network (Cloud Run: ingress rule on the
load balancer; K8s: NetworkPolicy). It is never exposed through Cloudflare.

### 2.3 Usage

```typescript
@Injectable()
export class OrdersService {
  constructor(
    @InjectMetric(MetricNames.ORDERS_CREATED) private readonly ordersCounter: Counter,
    @InjectMetric(MetricNames.ORDER_VALUE) private readonly orderValue: Histogram
  ) {}

  async create(input: CreateOrderInput, ctx: TenantContext): Promise<Order> {
    const order = await this.prisma.client.order.create({ data: this.buildOrder(input, ctx) })

    this.ordersCounter.inc({
      store_id: ctx.store.id,
      status: order.status,
      payment_method: order.paymentMethod
    })
    this.orderValue.observe({ store_id: ctx.store.id }, order.totalCents / 100)

    return order
  }
}
```

**Cardinality warning:** never use unbounded values as labels
(customer IDs, message IDs, free text). `store_id` is acceptable because
tenant count is bounded and it is the primary analysis dimension.

### 2.4 Queue metrics collector

Runs in `apps/worker` only (schedulers live there, `TDD_07` §4), under the leader lock so
one replica reports.

```typescript
@Injectable()
export class QueueMetricsService {
  constructor(
    private readonly queues: QueuesRegistry,             // Map<QueueName, Queue> from @nestjs/bullmq
    @InjectMetric(MetricNames.QUEUE_DEPTH) private readonly queueDepth: Gauge,
    private readonly locks: LeaderLockService,
  ) {}

  @Cron(Schedules.COLLECT_QUEUE_METRICS)
  async collect(): Promise<void> {
    await this.locks.withLock(LockNames.COLLECT_QUEUE_METRICS, 10, async () => {
      for (const [name, queue] of this.queues.entries()) {
        const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed')
        for (const [state, count] of Object.entries(counts)) {
          this.queueDepth.set({ queue: name, state }, count)
        }
      }
    })
  }
}
```

---

## 3. Error tracking (Sentry)

Packages: `@sentry/nestjs`, `@sentry/node`, `@sentry/profiling-node`, `@sentry/nextjs`
(`TDD_01` §2.4).

```typescript
// apps/api/src/instrument.ts — imported FIRST in main.ts
import * as Sentry from '@sentry/nestjs'
import { nodeProfilingIntegration } from '@sentry/profiling-node'
import { env } from '@platform/core/config'

if (env.SENTRY_DSN && env.NODE_ENV !== 'development') {
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    release: env.COMMIT_SHA,
    tracesSampleRate: 0.1,
    profilesSampleRate: 0.1,
    integrations: [nodeProfilingIntegration()],

    // Never send PII to Sentry
    beforeSend(event) {
      const data = event.request?.data
      if (isRecord(data)) {
        delete data['password']
        delete data['token']
        delete data['refreshToken']
        delete data['credentials']
      }
      return event
    },

    ignoreErrors: [
      'PlatformException',        // Expected business errors, already logged
      'ThrottlerException'
    ]
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
```

**Exception filter:**
```typescript
// libs/core/errors/global-exception.filter.ts
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(
    @InjectPinoLogger(GlobalExceptionFilter.name) private readonly logger: PinoLogger,
    @InjectMetric(MetricNames.TENANT_VIOLATIONS) private readonly tenantViolations: Counter,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp()
    const request = ctx.getRequest<AuthenticatedRequest>()
    const response = ctx.getResponse<Response>()

    // Known business errors: log as warn, do not report to Sentry
    if (exception instanceof PlatformException) {
      if (exception.code === ErrorCodes.TENANT_ACCESS_DENIED) {
        this.tenantViolations.inc({ resource: request.route?.path ?? 'unknown' })
      }

      this.logger.warn(
        { code: exception.code, metadata: exception.metadata },
        exception.message
      )

      response.status(exception.statusCode).json({
        error: {
          code: exception.code,
          message: exception.message,
          metadata: exception.metadata ?? {}
        },
        correlationId: request.correlationId
      })
      return
    }

    // Nest's own HttpExceptions (validation pipe, throttler) map to our contract too
    if (exception instanceof HttpException) {
      const code = exception instanceof ThrottlerException
        ? ErrorCodes.RATE_LIMIT_EXCEEDED
        : ErrorCodes.VALIDATION_FAILED
      response.status(exception.getStatus()).json({
        error: { code, message: exception.message, metadata: {} },
        correlationId: request.correlationId
      })
      return
    }

    // Unexpected errors: full report
    Sentry.withScope(scope => {
      scope.setContext('request', {
        url: request.url,
        method: request.method,
        correlationId: request.correlationId
      })
      scope.setUser({ id: request.user?.id ?? request.staff?.id })
      scope.setTag('store_id', request.store?.id ?? 'none')
      Sentry.captureException(exception)
    })

    this.logger.error({ err: exception }, 'unhandled exception')

    response.status(500).json({
      error: {
        code: ErrorCodes.INTERNAL_ERROR,
        message: 'An unexpected error occurred',
        metadata: {}
      },
      correlationId: request.correlationId
    })
  }
}
```

---

## 4. Health checks

Health routes are excluded from the `/api/v1` prefix (`TDD_02` §7) so probes and load
balancers hit `/health` and `/health/ready` directly.

```typescript
// apps/api/src/modules/health/health.controller.ts
@Controller()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,          // @nestjs/terminus
    private readonly prismaHealth: PrismaHealthIndicator, // custom: SELECT 1 through PrismaService.client
    private readonly redisHealth: RedisHealthIndicator,   // custom: ioredis PING
    private readonly storageHealth: StorageHealthIndicator, // custom: HeadBucket
  ) {}

  // Liveness: is the process alive? Must never touch dependencies.
  @Get(InfraRoutes.healthLive)
  @HealthCheck()
  live(): Promise<HealthCheckResult> {
    return this.health.check([async () => ({ api: { status: 'up' } })])
  }

  // Readiness: can it serve traffic? Checks the dependencies a request needs — and only those.
  // Queue depth is NOT a readiness signal: a backlog must scale workers, not remove API
  // instances from the load balancer.
  @Get(InfraRoutes.healthReady)
  @HealthCheck()
  ready(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.prismaHealth.isHealthy('database', { timeoutMs: 3000 }),
      () => this.redisHealth.isHealthy('redis', { timeoutMs: 2000 }),
      () => this.storageHealth.isHealthy('storage', { timeoutMs: 3000 }),
    ])
  }
}
```

> **v1.2 build order:** the three indicators arrive with their clients. Step 0.5 checks the database
> only; Redis joins in Step 1.0 and storage in Step 3.4 (`IMPLEMENTATION_PLAN.md`).

`apps/worker` exposes the same two routes through a minimal HTTP listener (Cloud Run needs
a port); its readiness additionally checks that at least one BullMQ worker is running.

**Probe configuration (Cloud Run uses the same paths via `--startup-probe`/`--liveness-probe`):**
```yaml
livenessProbe:
  httpGet: { path: /health, port: 8080 }
  initialDelaySeconds: 10
  periodSeconds: 15
  failureThreshold: 3

readinessProbe:
  httpGet: { path: /health/ready, port: 8080 }
  initialDelaySeconds: 5
  periodSeconds: 10
  failureThreshold: 2
```

---

## 5. Monitoring stack

### 5.1 Phase 1 — Cloud Run

Cloud Run has no Prometheus scrape target, so Phase 1 uses **Google Cloud Managed Service
for Prometheus** with the sidecar collector (`--container` `gcr.io/cloud-run-managed-prometheus`)
reading `/metrics` from each service. Alert rules in §6 are written in PromQL and loaded
into Cloud Monitoring; Grafana (Cloud Run, internal) reads from the managed Prometheus
datasource. Logs go to Cloud Logging through stdout; a log-based metric counts
`platform_tenant_violations_total` as a belt-and-braces alert.

### 5.2 Phase 2 — Kubernetes

```bash
# Prometheus + Grafana + Alertmanager
helm install prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace

# Loki for log aggregation
helm install loki grafana/loki-stack --namespace monitoring

# External metrics for HPA (queue depth), TDD_03 §6.2
helm install prometheus-adapter prometheus-community/prometheus-adapter --namespace monitoring
```

**Useful PromQL queries:**
```promql
# Request rate
sum(rate(http_requests_total{service="api"}[5m]))

# Error rate (as a ratio)
sum(rate(http_requests_total{status=~"5.."}[5m]))
  / sum(rate(http_requests_total[5m]))

# P95 latency
histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))

# Orders per minute by store
sum by (store_id) (rate(platform_orders_created_total[5m])) * 60

# Queue backlog
platform_queue_depth{state="waiting"}

# Cache hit ratio
sum(rate(platform_cache_hits_total[5m]))
  / (sum(rate(platform_cache_hits_total[5m])) + sum(rate(platform_cache_misses_total[5m])))

# Message send failures by channel
sum by (channel_type) (rate(platform_channel_api_errors_total[5m]))

# AI cost proxy (tokens per hour)
sum(rate(platform_ai_tokens_used_total[1h])) * 3600
```

**Grafana dashboards to build:**
1. **Service health** — request rate, error rate, latency percentiles, saturation
2. **Business** — conversations, messages, orders, revenue over time
3. **Queues** — depth, throughput, failure rate, processing time per queue
4. **Channels** — webhook volume, API errors, connection status per channel
5. **Infrastructure** — CPU, memory, instance/pod restarts, database connections
6. **Cost** — AI tokens and Chispas, storage growth, egress bandwidth

---

## 6. Alerting

Rules are the same PromQL in both phases; only the loader differs (Cloud Monitoring in
Phase 1, `PrometheusRule` CRD in Phase 2). Runbook links point at the repository
(`docs/runbooks/`, `TDD_14` §11).

```yaml
# monitoring/prometheus-rules.yaml
groups:
  - name: platform_critical
    rules:
      - alert: HighErrorRate
        expr: |
          sum(rate(http_requests_total{status=~"5.."}[5m]))
            / sum(rate(http_requests_total[5m])) > 0.05
        for: 5m
        labels: { severity: critical }
        annotations:
          summary: "Error rate above 5% ({{ $value | humanizePercentage }})"
          runbook: "https://github.com/ORG/platform/blob/main/docs/runbooks/high-error-rate.md"

      - alert: HighLatency
        expr: histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m]))) > 2
        for: 5m
        labels: { severity: warning }
        annotations:
          summary: "P95 latency above 2s ({{ $value }}s)"

      - alert: ServiceDown
        expr: absent(up{job="api"} == 1)
        for: 2m
        labels: { severity: critical }
        annotations:
          summary: "API service is down"

      - alert: TenantViolation
        expr: increase(platform_tenant_violations_total[5m]) > 0
        labels: { severity: critical }
        annotations:
          summary: "A request attempted cross-tenant access — treat as an incident"
          runbook: "https://github.com/ORG/platform/blob/main/docs/runbooks/tenant-violation.md"

  - name: platform_data
    rules:
      - alert: DatabaseConnectionsHigh
        expr: pg_stat_activity_count / pg_settings_max_connections > 0.8
        for: 5m
        labels: { severity: warning }
        annotations:
          summary: "Database connections above 80% of max"

      - alert: PgBouncerPoolExhausted
        expr: pgbouncer_pools_server_idle == 0 and pgbouncer_pools_client_waiting > 0
        for: 1m
        labels: { severity: critical }
        annotations:
          summary: "PgBouncer pool exhausted, clients are waiting"

      - alert: ReplicationLagHigh
        expr: pg_replication_lag_seconds > 30
        for: 5m
        labels: { severity: warning }
        annotations:
          summary: "Read replica lag above 30s"

  - name: platform_queues
    rules:
      - alert: QueueDepthHigh
        expr: platform_queue_depth{state="waiting"} > 1000
        for: 5m
        labels: { severity: warning }
        annotations:
          summary: "Queue {{ $labels.queue }} has {{ $value }} waiting jobs"
          runbook: "https://github.com/ORG/platform/blob/main/docs/runbooks/queue-backlog.md"

      - alert: QueueFailureRateHigh
        expr: sum by (queue) (rate(platform_queue_failed_total[5m])) > 0.1
        for: 2m
        labels: { severity: critical }
        annotations:
          summary: "Queue {{ $labels.queue }} failing at {{ $value }} jobs/sec"

      - alert: QueueStalled
        expr: |
          platform_queue_depth{state="waiting"} > 100
            and on (queue) sum by (queue) (rate(platform_queue_processed_total[10m])) == 0
        for: 10m
        labels: { severity: critical }
        annotations:
          summary: "Queue {{ $labels.queue }} has backlog but zero throughput"

      - alert: DeadLetterNonEmpty
        expr: platform_queue_depth{queue="dead-letter", state="waiting"} > 0
        for: 30m
        labels: { severity: warning }
        annotations:
          summary: "Dead-letter queue has {{ $value }} jobs awaiting triage"

  - name: platform_channels
    rules:
      - alert: ChannelApiErrorsHigh
        expr: sum by (channel_type) (rate(platform_channel_api_errors_total[5m])) > 0.05
        for: 5m
        labels: { severity: warning }
        annotations:
          summary: "{{ $labels.channel_type }} API errors elevated"
          runbook: "https://github.com/ORG/platform/blob/main/docs/runbooks/channel-outage.md"

      - alert: NoWebhooksReceived
        expr: sum(rate(platform_channel_webhook_received_total[30m])) == 0
        for: 30m
        labels: { severity: critical }
        annotations:
          summary: "No channel webhooks received in 30 minutes — possible integration outage"

  - name: platform_business
    rules:
      - alert: AICostSpike
        expr: sum(rate(platform_ai_tokens_used_total[1h])) * 3600 > 1000000
        for: 15m
        labels: { severity: warning }
        annotations:
          summary: "AI token consumption unusually high"
```

**Routing:**
```
severity: critical  → PagerDuty (on-call) + Slack #incidents
severity: warning   → Slack #alerts
severity: info      → Slack #monitoring (no notification)
```

---

## 7. Logging what matters

**Always log:**
- Authentication attempts (success and failure)
- Permission denials
- Tenant boundary violations (should be zero — any occurrence is an incident; it also increments `TENANT_VIOLATIONS`)
- External API calls (channel APIs, Stripe, AI provider) with duration and outcome
- Queue job start, completion and failure
- Database migrations
- Destructive operations (deletes, merges, revocations)
- Rate limit hits
- Staff actions and impersonation start/end (`TDD_15`)

**Never log:**
- Passwords, tokens, API keys, secrets (redaction is configured, but do not rely on it alone)
- Full message content (log message ID and length instead)
- Customer PII beyond identifiers
- Full request or response bodies
- Payment card data (never touches our systems — Stripe handles it)

---

## 8. Dashboards for the internal team

```
Service Health (default view)
├─ Request rate, error rate, P50/P95/P99 latency
├─ Active WebSocket connections
├─ Queue depth per queue
└─ Instance status and restarts

Business Health (daily standup view)
├─ Conversations created / resolved (24h, 7d, 30d)
├─ Messages by channel
├─ Orders created and total value
├─ Active stores and agents
└─ Signup funnel

Cost Watch (weekly review)
├─ AI tokens, Chispas spent and estimated spend
├─ Storage growth rate
├─ Egress bandwidth
├─ Database size
└─ Compute utilization vs requests
```
