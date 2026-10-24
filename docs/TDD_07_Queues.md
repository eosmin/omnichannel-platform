# TDD 07 — Queues, Email & File Handling

> Part of the Omnichannel Commerce Platform TDD v1.1
> **MVP v1.2:** this file describes the full product. Before implementing from it, read `MVP_TRIM_CHECKLIST.md`;
> where the two disagree, the checklist wins.
> Covers: BullMQ design, workers, DLQ, email system, file upload/download

---

## 1. Queue architecture

### 1.1 Queue design

Eight queues, separated by priority and failure characteristics.
A slow analytics job must never delay a password reset email, and an autonomous chatbot
turn must never wait behind a virus scan.

```
┌──────────────────┬───────────────────┬─────────────────────┬─────────────────────┐
│ inbound          │ email             │ notifications       │ ai                  │
│ Priority: HIGH   │ Priority: HIGH    │ Priority: HIGH      │ Priority: HIGH      │
│ Concurrency: 20  │ Concurrency: 10   │ Concurrency: 20     │ Concurrency: 5      │
│ Attempts: 5      │ Attempts: 3       │ Attempts: 5         │ Attempts: 2         │
│ Backoff: exp 1s  │ Backoff: exp 2s   │ Backoff: fixed 5s   │ Backoff: exp 2s     │
│                  │ Rate: 100/s       │                     │ 1 job / conversation│
├──────────────────┼───────────────────┼─────────────────────┼─────────────────────┤
│ webhooks         │ analytics         │ exports             │ heavy-processing    │
│ Priority: MEDIUM │ Priority: LOW     │ Priority: LOW       │ Priority: LOW       │
│ Concurrency: 20  │ Concurrency: 5    │ Concurrency: 2      │ Concurrency: 2      │
│ Attempts: 5      │ Attempts: 1       │ Attempts: 3         │ Attempts: 2         │
│ Backoff: exp 1s  │ Delay: 5s batch   │ Backoff: fixed 10s  │ Backoff: exp 5s     │
└──────────────────┴───────────────────┴─────────────────────┴─────────────────────┘
                                   ↓ exhausted retries
                         ┌─────────────────────┐
                         │ dead-letter         │
                         │ Never auto-removed  │
                         │ Manual inspection   │
                         └─────────────────────┘
```

### 1.2 Definitions

Queues are registered through `@nestjs/bullmq` — no module-level `new Queue()`. The same
`QueuesModule` is imported by `apps/api` (producers) and `apps/worker` (consumers); only
the worker registers processors.

```typescript
// libs/core/queues/queues.module.ts
import { BullModule } from '@nestjs/bullmq'
import type { DefaultJobOptions } from 'bullmq'

const base: DefaultJobOptions = {
  removeOnComplete: { count: 1000, age: 24 * 3600 },
  removeOnFail: { count: 5000 },
}

export const QueueJobOptions: Record<QueueName, DefaultJobOptions> = {
  [QueueNames.INBOUND]:          { ...base, attempts: 5, backoff: { type: 'exponential', delay: 1000 } },
  [QueueNames.EMAIL]:            { ...base, attempts: 3, backoff: { type: 'exponential', delay: 2000 } },
  [QueueNames.WEBHOOKS]:         { ...base, attempts: 5, backoff: { type: 'exponential', delay: 1000 } },
  [QueueNames.NOTIFICATIONS]:    { ...base, attempts: 5, backoff: { type: 'fixed', delay: 5000 } },
  [QueueNames.ANALYTICS]:        { ...base, attempts: 1, delay: 5000 },   // Small delay lets nearby events batch
  [QueueNames.EXPORTS]:          { ...base, attempts: 3, backoff: { type: 'fixed', delay: 10_000 } },
  [QueueNames.HEAVY_PROCESSING]: { ...base, attempts: 2, backoff: { type: 'exponential', delay: 5000 } },
  [QueueNames.AI]:               { ...base, attempts: 2, backoff: { type: 'exponential', delay: 2000 } },
  [QueueNames.DEAD_LETTER]:      { removeOnComplete: false, removeOnFail: false },   // Never auto-remove
}

@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: () => ({
        connection: {
          // ioredis accepts the URL directly; TLS is implied by rediss://
          url: env.REDIS_QUEUE_URL ?? env.REDIS_URL,
          maxRetriesPerRequest: null,           // Required by BullMQ
        },
      }),
    }),
    ...Object.values(QueueNames).map(name =>
      BullModule.registerQueue({ name, defaultJobOptions: QueueJobOptions[name] })
    ),
  ],
  exports: [BullModule],
})
export class QueuesModule {}
```

Producers inject a queue with `@InjectQueue(QueueNames.EMAIL) private readonly emailQueue: Queue<SendEmailJob>`.
Code that needs every queue (Bull Board, the DLQ replay, the metrics collector) injects
`QueuesRegistry` — a small provider in the same module exposing `get(name)` and `entries()`
over the `@nestjs/bullmq` queue tokens, so no file holds its own list of queues.

### 1.3 Job payload types

Every payload is a plain, JSON-serializable object and carries `correlationId` when it
originates from a request (`TDD_04` §1.3).

```typescript
// libs/core/queues/job-types.ts
interface BaseJob { correlationId?: string }

// inbound
export interface ProcessChannelEventJob extends BaseJob {
  pluginId: ChannelType
  event: ChannelEvent                      // Normalized by the plugin (TDD_10 §2)
  receivedAt: string
}

// email — one job type; the template decides content and subject
export interface SendEmailJob extends BaseJob {
  template: EmailTemplate
  to: string | string[]
  locale: Locale
  data: Record<string, unknown>
  attachments?: Array<{ filename: string; contentBase64: string; contentType: string }>
  tags: { storeId?: string; template: EmailTemplate }   // Echoed back by the Resend webhook (§5.4)
}

// webhooks
export interface TriggerWebhookJob extends BaseJob {
  webhookId: string                        // Tenant Webhook row
  storeId: string
  event: EventName
  payload: Record<string, unknown>
}

export interface TriggerPluginWebhookJob extends BaseJob {
  pluginInstallationId: string             // Endpoint + secret come from the manifest (TDD_10 §6.5)
  storeId: string
  event: EventName
  payload: Record<string, unknown>
}

// notifications
export interface SendWebPushJob extends BaseJob { userId: string; notificationId: string }
export interface QueueEmailDigestJob extends BaseJob { userId: string; notificationId: string }
export interface SendEmailDigestJob extends BaseJob { userId: string; frequency: DigestFrequency }

// analytics
export interface TrackAnalyticsJob extends BaseJob {
  event: AnalyticsEventName                // TDD_11 §7.1
  storeId: string
  data: Record<string, unknown>
  timestamp: string
}
export interface RollupJob extends BaseJob { storeId: string; periodStart: string; periodEnd: string }
export interface ReportStripeUsageJob extends BaseJob { subscriptionId: string }

// exports
export const ExportTypes = {
  CONVERSATIONS: 'conversations',
  CUSTOMERS: 'customers',
  ORDERS: 'orders',
  AUDIT_LOG: 'audit_log',
  ANALYTICS: 'analytics',
  MEDIA_ZIP: 'media_zip',
} as const
export type ExportType = typeof ExportTypes[keyof typeof ExportTypes]

export const ExportFormats = { CSV: 'csv', EXCEL: 'excel', PDF: 'pdf', ZIP: 'zip' } as const
export type ExportFormat = typeof ExportFormats[keyof typeof ExportFormats]

export interface GenerateExportJob extends BaseJob { exportId: string }          // Everything else is on the Export row
export interface GenerateScheduledReportJob extends BaseJob { reportId: string }
export interface DsrExportJob extends BaseJob { requestId: string }
export interface DsrEraseJob extends BaseJob { requestId: string }
export interface ProcessPartnerPayoutJob extends BaseJob { payoutId: string }   // Payout row created first (idempotencyKey)
export interface ExportAuditLogsJob extends BaseJob { before: string }

// heavy processing
export interface ScanFileJob extends BaseJob { mediaId: string }
export interface ProcessImageJob extends BaseJob { mediaId: string }
export interface FetchInboundMediaJob extends BaseJob { messageId: string; storeId: string; pluginId: ChannelType; connectionId: string; mediaRef: string; contentType: string; filename: string | null }
export interface EnforceRetentionJob extends BaseJob { storeId: string }

// ai
export interface AutonomousTurnJob extends BaseJob { conversationId: string; storeId: string; messageId: string }

// dead letter
export interface DeadLetterJob {
  originalQueue: QueueName
  originalJobName: JobName
  originalJobId: string | undefined
  originalData: unknown
  error: string
  failedAt: string
}
```

### 1.4 Worker structure

`apps/worker` is a NestJS application (same DI, same `libs/core` modules as the API). It
boots an application context plus a minimal HTTP listener for Cloud Run probes.

```
apps/worker/src/
├─ main.ts                        # NestFactory.create(WorkerModule) → /health, /health/ready only
├─ worker.module.ts               # QueuesModule, ScheduleModule.forRoot(), processors, schedulers
├─ processors/
│  ├─ inbound.processor.ts        # PROCESS_CHANNEL_EVENT
│  ├─ email.processor.ts
│  ├─ webhook.processor.ts        # TRIGGER_WEBHOOK, TRIGGER_PLUGIN_WEBHOOK
│  ├─ notification.processor.ts   # SEND_WEB_PUSH, QUEUE_EMAIL_DIGEST, SEND_EMAIL_DIGEST
│  ├─ analytics.processor.ts
│  ├─ export.processor.ts
│  ├─ heavy-processing.processor.ts
│  └─ ai.processor.ts             # PROCESS_AUTONOMOUS_CHATBOT_TURN
├─ schedulers/
│  ├─ leader-lock.service.ts
│  ├─ rollup.scheduler.ts         # Hourly and daily metric rollups
│  ├─ retention.scheduler.ts      # Retention enforcement, platform cleanup, audit cold export
│  ├─ conversations.scheduler.ts  # Wake snoozed, auto-archive
│  ├─ billing.scheduler.ts        # Dunning, Stripe usage, quota warnings, AI credit reset
│  ├─ reports.scheduler.ts        # Scheduled report dispatch, email digests
│  ├─ referrals.scheduler.ts      # Approvals, monthly payouts
│  ├─ channels.scheduler.ts       # Channel health
│  ├─ compliance.scheduler.ts     # DSR deadline alerts
│  └─ admin.scheduler.ts          # Impersonation expiry, queue metrics
└─ health/
   └─ worker-health.controller.ts
```

`ScheduleModule` is imported **only** here — `apps/api` never runs crons.

### 1.5 Processor pattern

```typescript
// apps/worker/src/processors/email.processor.ts
import { Processor, WorkerHost, OnWorkerEvent, InjectQueue } from '@nestjs/bullmq'
import type { Job, Queue } from 'bullmq'

@Processor(QueueNames.EMAIL, {
  concurrency: 10,
  limiter: { max: 100, duration: 1000 },     // Respect provider rate limit
})
export class EmailProcessor extends WorkerHost {
  constructor(
    private readonly email: EmailService,
    @InjectQueue(QueueNames.DEAD_LETTER) private readonly deadLetter: Queue<DeadLetterJob>,
    @InjectMetric(MetricNames.QUEUE_PROCESSED) private readonly processed: Counter,
    @InjectMetric(MetricNames.QUEUE_FAILED) private readonly failed: Counter,
    @InjectMetric(MetricNames.QUEUE_PROCESSING_DURATION) private readonly duration: Histogram,
    @InjectPinoLogger(EmailProcessor.name) private readonly logger: PinoLogger,
  ) { super() }

  async process(job: Job<SendEmailJob>): Promise<void> {
    const startedAt = Date.now()
    this.logger.info({ jobId: job.id, template: job.data.template, correlationId: job.data.correlationId }, 'processing email job')

    await this.email.send(job.data)

    this.duration.observe({ queue: QueueNames.EMAIL, job: job.name }, (Date.now() - startedAt) / 1000)
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job): void {
    this.processed.inc({ queue: QueueNames.EMAIL, job: job.name })
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<SendEmailJob> | undefined, err: Error): Promise<void> {
    this.failed.inc({ queue: QueueNames.EMAIL, job: job?.name ?? 'unknown' })
    this.logger.error({ jobId: job?.id, err: err.message }, 'email job failed')

    // Route to DLQ after the final attempt
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      await this.deadLetter.add(JobNames.EXHAUSTED, {
        originalQueue: QueueNames.EMAIL,
        originalJobName: job.name as JobName,
        originalJobId: job.id,
        originalData: job.data,
        error: err.message,
        failedAt: new Date().toISOString(),
      })
    }
  }
}
```

**Every processor follows this shape:** structured logging, metric emission, DLQ routing
on exhaustion. The shared parts live in `apps/worker/src/processors/base.processor.ts`.

**Per-conversation serialization (AI queue):** `AutonomousTurnJob`s are added with
`jobId: conversationId` and BullMQ's `deduplication: { id: conversationId }` option, so a
second inbound message while a turn is running is folded into one job instead of racing.

### 1.6 Graceful shutdown

```typescript
// apps/worker/src/main.ts
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(WorkerModule, { logger: false })   // Pino via LoggerModule
  app.useLogger(app.get(Logger))
  app.enableShutdownHooks()            // SIGTERM/SIGINT → onModuleDestroy on every WorkerHost (waits for in-flight jobs)
  await app.listen(env.PORT)           // /health, /health/ready only
}
void bootstrap()
```

`@nestjs/bullmq` closes each `Worker` on `onModuleDestroy` — `close()` waits for in-flight
jobs to finish — then `PrismaService.onModuleDestroy` disconnects. `AuditService` flushes its
pending writes in the same phase (`TDD_05` §9.2). This is what makes spot instances safe
for workers.

---

## 2. Webhook delivery

```typescript
// apps/worker/src/processors/webhook.processor.ts
async processTenantWebhook(job: Job<TriggerWebhookJob>): Promise<void> {
  const { webhookId, storeId, event, payload } = job.data

  const webhook = await this.prisma.client.webhook.findFirst({ where: { id: webhookId, storeId } })
  if (!webhook || webhook.status !== WebhookStatus.ACTIVE) return

  const secret = decryptString(webhook.secret)
  const body = JSON.stringify({ event, data: payload, timestamp: Date.now(), deliveryId: job.id })
  const signature = crypto.createHmac('sha256', secret).update(body).digest('hex')

  const startedAt = Date.now()

  try {
    const response = await this.http.post(webhook.url, body, {
      headers: {
        'Content-Type': 'application/json',
        [WebhookHeaders.SIGNATURE]: `sha256=${signature}`,
        [WebhookHeaders.EVENT]: event,
        [WebhookHeaders.DELIVERY]: job.id ?? '',
        [CORRELATION_ID_HEADER]: job.data.correlationId ?? '',
      },
      timeout: 10_000,
      maxRedirects: 0,                        // Prevent SSRF via redirect
      validateStatus: s => s >= 200 && s < 300,
    })

    await this.prisma.client.$transaction([
      this.prisma.client.webhookDelivery.create({
        data: { webhookId, event, statusCode: response.status, durationMs: Date.now() - startedAt, success: true, attempt: job.attemptsMade + 1 },
      }),
      this.prisma.client.webhook.update({ where: { id: webhookId }, data: { consecutiveFailures: 0 } }),
    ])
  } catch (error: unknown) {
    const statusCode = axios.isAxiosError(error) ? error.response?.status ?? 0 : 0

    const updated = await this.prisma.client.$transaction(async tx => {
      await tx.webhookDelivery.create({
        data: {
          webhookId, event, statusCode, durationMs: Date.now() - startedAt, success: false,
          error: error instanceof Error ? error.message : 'unknown', attempt: job.attemptsMade + 1,
        },
      })
      return tx.webhook.update({
        where: { id: webhookId },
        data: { consecutiveFailures: { increment: 1 }, lastFailureAt: new Date() },
      })
    })

    // Auto-disable after 20 consecutive failures (any status) — notify admins once
    if (updated.consecutiveFailures >= WebhookLimits.MAX_CONSECUTIVE_FAILURES) {
      await this.webhooks.autoDisable(webhookId, storeId)    // status → DISABLED, WEBHOOK_AUTO_DISABLED notification + event
      return
    }

    // 4xx (except 408/429) are permanent for THIS delivery — do not retry it
    if (statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429) return

    throw error    // Triggers BullMQ retry
  }
}
```

`WebhookHeaders` and `WebhookLimits` live in `libs/core/domain/webhook-constants.ts`.
Plugin webhooks (`TriggerPluginWebhookJob`) follow the same code path with the endpoint and
secret read from the installation's manifest (`TDD_10` §6.5) and payloads redacted to the
granted scopes.

**SSRF protection.** The URL is validated at creation time **and** resolved at delivery
time; the delivery client pins the resolved address so DNS rebinding cannot redirect the
request after validation.

```typescript
// libs/core/domain/url-safety.ts
import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import ipaddr from 'ipaddr.js'

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal', 'metadata', 'instance-data'])
const BLOCKED_RANGES = ['unspecified', 'loopback', 'private', 'linkLocal', 'carrierGradeNat', 'uniqueLocal', 'multicast', 'broadcast', 'reserved'] as const

function isPublicAddress(address: string): boolean {
  let parsed = ipaddr.parse(address)
  if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    parsed = (parsed as ipaddr.IPv6).toIPv4Address()
  }
  return !BLOCKED_RANGES.includes(parsed.range() as typeof BLOCKED_RANGES[number])
}

export async function assertPublicHttpsUrl(url: string): Promise<{ hostname: string; addresses: string[] }> {
  const parsed = new URL(url)                       // Throws on garbage; decimal/octal IPs are normalized here
  if (parsed.protocol !== 'https:') {
    throw new PlatformException(ErrorCodes.VALIDATION_URL_NOT_ALLOWED, 'HTTPS required', 400)
  }
  if (parsed.username || parsed.password || BLOCKED_HOSTNAMES.has(parsed.hostname.toLowerCase())) {
    throw new PlatformException(ErrorCodes.VALIDATION_URL_NOT_ALLOWED, 'Host not allowed', 400)
  }

  const addresses = isIP(parsed.hostname)
    ? [parsed.hostname]
    : (await lookup(parsed.hostname, { all: true })).map(r => r.address)

  if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
    throw new PlatformException(ErrorCodes.VALIDATION_URL_NOT_ALLOWED, 'Address not allowed', 400)
  }
  return { hostname: parsed.hostname, addresses }
}
```

At delivery time the processor calls `assertPublicHttpsUrl` again and passes a custom
`lookup` to the axios `https.Agent` that returns only the validated addresses. `ipaddr.js`
is pinned in `TDD_01` §2.4 alongside `axios`.

---

## 3. Dead letter queue

Bull Board is mounted through `@bull-board/nestjs` with the Express adapter at
`InfraRoutes.queues` (`/admin/queues`, outside the API prefix), guarded by
`StaffAuthGuard` + `StaffPermissionGuard(StaffPermissions.QUEUES_VIEW)` — it is a staff tool
(`TDD_15` §2).

```typescript
// apps/api/src/modules/admin/queues-dashboard.module.ts
@Module({
  imports: [
    BullBoardModule.forRoot({
      route: InfraRoutes.queues,
      adapter: ExpressAdapter,
      middleware: [StaffAuthMiddleware],                     // Rejects non-staff before the board renders
    }),
    ...Object.values(QueueNames).map(name =>
      BullBoardModule.forFeature({ name, adapter: BullMQAdapter })
    ),
  ],
})
export class QueuesDashboardModule {}
```

**DLQ triage procedure:**
```
1. Review daily. A non-empty DLQ is a signal, not a normal state (alert DeadLetterNonEmpty, TDD_04 §6).
2. Group by originalQueue and error message.
3. Transient cause (provider outage) → replay the batch.
4. Bug → fix, deploy, then replay.
5. Invalid data → discard with a recorded reason.
6. Recurring pattern → add a regression test.
```

```typescript
// libs/core/queues/dead-letter.service.ts — exposed at AdminRoutes.queues.replay (staff only, audited)
@Injectable()
export class DeadLetterService {
  constructor(private readonly queues: QueuesRegistry) {}

  async replay(filter: { originalQueue?: QueueName; limit?: number }): Promise<number> {
    const dlq = this.queues.get(QueueNames.DEAD_LETTER)
    const jobs = await dlq.getJobs(['waiting', 'delayed'], 0, (filter.limit ?? 100) - 1)

    let replayed = 0
    for (const job of jobs) {
      const data = deadLetterJobSchema.parse(job.data)      // Zod: DLQ contents are data, not trusted
      if (filter.originalQueue && data.originalQueue !== filter.originalQueue) continue

      await this.queues.get(data.originalQueue).add(data.originalJobName, data.originalData)
      await job.remove()
      replayed++
    }
    return replayed
  }
}
```

---

## 4. Scheduled jobs

```typescript
// libs/core/queues/schedules.ts
export const Schedules = {
  ROLLUP_HOURLY:              '5 * * * *',        // :05 every hour, previous hour
  ROLLUP_DAILY:               '15 0 * * *',       // 00:15 UTC, previous day
  ENFORCE_RETENTION:          '0 * * * *',        // Hourly; picks stores whose local time is 03:00 (TDD_05 §10.4)
  CLEANUP_PLATFORM_DATA:      '0 1 * * *',        // 01:00 UTC: sessions, tokens, deliveries, exports, merges
  EXPORT_AUDIT_LOGS:          '0 2 1 * *',        // 02:00 UTC on the 1st: cold export + purge (TDD_05 §9.3)
  WAKE_SNOOZED:               '* * * * *',        // Every minute
  AUTO_ARCHIVE_RESOLVED:      '30 * * * *',       // Hourly
  DISPATCH_REPORTS:           '0 * * * *',        // Hourly, checks per-store send hour
  SEND_EMAIL_DIGEST_HOURLY:   '10 * * * *',
  SEND_EMAIL_DIGEST_DAILY:    '10 * * * *',       // Every hour at :10; sends to the users whose local time is 08:10
  PROCESS_DUNNING:            '0 10 * * *',       // 10:00 UTC daily
  APPROVE_REFERRALS:          '0 5 * * *',        // 05:00 UTC daily
  PROCESS_PAYOUTS:            '0 6 1 * *',        // 06:00 UTC on the 1st
  REPORT_STRIPE_USAGE:        '0 4 * * *',        // 04:00 UTC daily
  CHECK_QUOTA_LIMITS:         '0 9 * * *',        // 09:00 UTC daily
  RESET_AI_CREDITS:           '20 0 * * *',       // 00:20 UTC daily; resets orgs whose period rolled over (TDD_12 §9.5)
  NOTIFY_TRIAL_ENDING:        '0 8 * * *',        // 08:00 UTC daily, 3 days before trialEndsAt
  CHECK_CHANNEL_HEALTH:       '*/5 * * * *',      // Every 5 minutes (TDD_10 §10)
  CHECK_DSR_DEADLINES:        '0 7 * * *',        // 07:00 UTC daily (TDD_05 §10.2)
  COLLECT_QUEUE_METRICS:      '*/15 * * * * *',   // Every 15 seconds (6-field cron, @nestjs/schedule)
  EXPIRE_IMPERSONATION_SESSIONS: '* * * * *',     // Every minute (TDD_15 §4)
} as const

export const LockNames = Object.fromEntries(
  Object.keys(Schedules).map(k => [k, k.toLowerCase()])
) as Record<keyof typeof Schedules, string>
```

**Single-instance guarantee.** Schedulers run only in `apps/worker`, which has 1-5
replicas; every `@Cron` body runs inside `LeaderLockService.withLock` so exactly one
replica executes a given schedule. The lock is released with a compare-and-delete Lua
script, so a replica that overran its TTL cannot delete a lock another replica now holds.

```typescript
// apps/worker/src/schedulers/leader-lock.service.ts
const RELEASE_SCRIPT = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`

@Injectable()
export class LeaderLockService {
  private readonly instanceId = randomUUID()

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async withLock(name: string, ttlSeconds: number, fn: () => Promise<void>): Promise<boolean> {
    const key = CacheKeys.lock(name)
    const acquired = await this.redis.set(key, this.instanceId, 'EX', ttlSeconds, 'NX')
    if (acquired !== 'OK') return false
    try {
      await fn()
    } finally {
      await this.redis.eval(RELEASE_SCRIPT, 1, key, this.instanceId)
    }
    return true
  }
}
```

**Snooze wake job.** Status changes go through `ConversationsService.updateStatus` so
the transition is validated and `CONVERSATION_STATUS_CHANGED` / `CONVERSATION_SNOOZE_EXPIRED`
fire (cache invalidation, realtime and notifications all hang off those events —
`TDD_02` §5):

```typescript
// apps/worker/src/schedulers/conversations.scheduler.ts
@Injectable()
export class ConversationsScheduler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly locks: LeaderLockService,
  ) {}

  @Cron(Schedules.WAKE_SNOOZED)
  async wakeSnoozed(): Promise<void> {
    await this.locks.withLock(LockNames.WAKE_SNOOZED, 55, async () => {
      const due = await this.prisma.client.conversation.findMany({
        where: { status: ConversationStatus.SNOOZED, snoozedUntil: { lte: new Date() } },
        select: { id: true, storeId: true },
        take: 500,
      })
      for (const conv of due) {
        await this.conversations.updateStatus(conv.id, conv.storeId, ConversationStatus.OPEN, {
          actor: { type: 'system', id: null },
          reason: ConversationStatusReasons.SNOOZE_EXPIRED,
        })
      }
    })
  }

  @Cron(Schedules.AUTO_ARCHIVE_RESOLVED)
  async autoArchive(): Promise<void> {
    await this.locks.withLock(LockNames.AUTO_ARCHIVE_RESOLVED, 300, async () => {
      // Per-store threshold from StoreSettings.autoArchiveAfterDays
      const due = await this.prisma.client.$queryRaw<Array<{ id: string; store_id: string }>>`
        SELECT c.id, c.store_id
        FROM conversations c
        JOIN store_settings s ON s.store_id = c.store_id
        WHERE c.status = ${ConversationStatus.RESOLVED}
          AND c.resolved_at < NOW() - make_interval(days => s.auto_archive_after_days)
        LIMIT 500
      `
      for (const conv of due) {
        await this.conversations.updateStatus(conv.id, conv.store_id, ConversationStatus.ARCHIVED, {
          actor: { type: 'system', id: null },
          reason: ConversationStatusReasons.AUTO_ARCHIVED,
        })
      }
    })
  }
}
```

**Impersonation expiry** (`Schedules.EXPIRE_IMPERSONATION_SESSIONS`) has the same shape and
calls `ImpersonationService.end(sessionId, ImpersonationEndedBy.EXPIRED)` (`TDD_15` §4).

---

## 5. Email system

### 5.1 Provider abstraction

**Decision: Resend, and only Resend, in Phase 1** (`TDD_01` §2.4). The interface exists so
a second provider can be added later without touching callers; no other implementation
exists until then.

```typescript
// libs/core/email/email-provider.interface.ts
export interface EmailProvider {
  send(options: SendEmailOptions): Promise<{ providerMessageId: string }>
}

export interface SendEmailOptions {
  to: string | string[]
  subject: string
  html: string
  text: string
  replyTo?: string
  headers?: Record<string, string>
  tags: Record<string, string>
  attachments?: Array<{ filename: string; content: Buffer; contentType: string }>
}

export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER')

// libs/core/email/email.module.ts
@Module({
  providers: [
    { provide: EMAIL_PROVIDER, useClass: ResendProvider },   // The only binding in Phase 1
    TemplateRenderer,
    EmailService,
  ],
  exports: [EmailService],
})
export class EmailModule {}

// libs/core/email/email.service.ts
@Injectable()
export class EmailService {
  constructor(
    @Inject(EMAIL_PROVIDER) private readonly provider: EmailProvider,
    private readonly renderer: TemplateRenderer,
    @InjectMetric(MetricNames.EMAILS_SENT) private readonly emailsSent: Counter,
  ) {}

  async send(job: SendEmailJob): Promise<void> {
    const { subject, html, text } = await this.renderer.render(job.template, job.locale, job.data)

    await this.provider.send({
      to: job.to,
      subject, html, text,
      tags: job.tags,                                 // storeId + template, echoed by the webhook (§5.4)
      attachments: job.attachments?.map(a => ({
        filename: a.filename,
        content: Buffer.from(a.contentBase64, 'base64'),
        contentType: a.contentType,
      })),
    })
    this.emailsSent.inc({ template: job.template })
  }
}
```

### 5.2 Templates (React Email)

```typescript
// libs/core/email/templates/index.ts
export const EmailTemplates = {
  EMAIL_VERIFICATION: 'email-verification',
  PASSWORD_RESET: 'password-reset',
  PASSWORD_CHANGED: 'password-changed',
  TEAM_INVITATION: 'team-invitation',
  WELCOME: 'welcome',
  ORDER_CONFIRMATION: 'order-confirmation',
  SHIPMENT_NOTIFICATION: 'shipment-notification',
  ORDER_DELIVERED: 'order-delivered',
  ORDER_CANCELLED: 'order-cancelled',
  NOTIFICATION_DIGEST: 'notification-digest',
  NOTIFICATION_IMMEDIATE: 'notification-immediate',
  SCHEDULED_REPORT: 'scheduled-report',
  EXPORT_READY: 'export-ready',
  QUOTA_WARNING: 'quota-warning',
  AI_CREDITS_LOW: 'ai-credits-low',
  PAYMENT_FAILED_1: 'payment-failed-1',
  PAYMENT_FAILED_2: 'payment-failed-2',
  PAYMENT_FAILED_3: 'payment-failed-3',
  ACCOUNT_RESTRICTED: 'account-restricted',
  ACCOUNT_SUSPENDED: 'account-suspended',
  TRIAL_ENDING: 'trial-ending',
  DSR_VERIFICATION: 'dsr-verification',
  DSR_EXPORT_READY: 'dsr-export-ready',
  DSR_COMPLETED: 'dsr-completed',
  DSR_DEADLINE_APPROACHING: 'dsr-deadline-approaching',
  PAYOUT_CONFIRMATION: 'payout-confirmation',
  CHANNEL_DISCONNECTED: 'channel-disconnected',
  WEBHOOK_AUTO_DISABLED: 'webhook-auto-disabled',
  IMPERSONATION_STARTED: 'impersonation-started',
  EMAIL_CHANNEL_REPLY: 'email-channel-reply',       // Outbound reply for the email channel (TDD_10 §5.5)
} as const

export type EmailTemplate = typeof EmailTemplates[keyof typeof EmailTemplates]
```

```tsx
// libs/core/email/templates/EmailVerification.tsx
import { Html, Head, Body, Container, Section, Text, Button, Img, Hr } from '@react-email/components'
import { createTranslator } from '../../i18n'
import { emailAssets } from '../email-assets'          // Absolute URLs from env (CDN), never literals
import { main, container, heading, paragraph, buttonContainer, button, link, hr, footer } from './styles'

interface Props {
  name: string
  verificationUrl: string
  locale: Locale
}

export default function EmailVerification({ name, verificationUrl, locale }: Props): JSX.Element {
  const t = createTranslator(locale, 'email.verification')

  return (
    <Html lang={locale}>
      <Head />
      <Body style={main}>
        <Container style={container}>
          <Img src={emailAssets.logo} width="48" height="48" alt={t('logoAlt')} />
          <Text style={heading}>{t('heading')}</Text>
          <Text style={paragraph}>{t('greeting', { name })}</Text>
          <Text style={paragraph}>{t('body')}</Text>
          <Section style={buttonContainer}>
            <Button style={button} href={verificationUrl}>{t('cta')}</Button>
          </Section>
          <Text style={paragraph}>{t('fallback')}</Text>
          <Text style={link}>{verificationUrl}</Text>
          <Hr style={hr} />
          <Text style={footer}>{t('expiry')}</Text>
          <Text style={footer}>{t('ignore')}</Text>
        </Container>
      </Body>
    </Html>
  )
}
```

`createTranslator` is the server-side translator from `libs/core/i18n` (same message files
as next-intl, no React hook). Every template has a golden-render test per locale.

**Email localization exception:** unlike API errors, emails ARE translated
server-side, because the recipient is not present to translate. The locale
comes from `User.locale`, `Customer.locale` or `Store.defaultLocale`.

```bash
pnpm email:dev    # Preview all templates at http://localhost:3001
```

### 5.3 Email flows

All tokens are 256-bit random values; only their SHA-256 hash is stored
(`VerificationToken`, `Invitation.tokenHash`, `TDD_01` §4).

**Signup verification:**
```
POST /auth/signup
  → create User (emailVerified: false) + Organization (Free) + Subscription + first Store (from the wizard, TDD_09 §14)
  → VerificationToken { type: EMAIL_VERIFICATION, expiresAt: +24h }
  → emailQueue.add(SEND_EMAIL, { template: EMAIL_VERIFICATION, … })
  → response: 201 { userId } — the UI shows "check your email"

Login before verification → 403 AUTH_EMAIL_NOT_VERIFIED
  → UI offers resend (POST /auth/resend-verification, 3/hour, always 200)
POST /auth/verify-email { token }
  → hash, find unused & unexpired → User.emailVerified = true, usedAt set → USER_EMAIL_VERIFIED
```

**Password reset:**
```
POST /auth/forgot-password
  → always returns 200 with the same body (no email enumeration)
  → if user exists: VerificationToken { type: PASSWORD_RESET, expiresAt: +1h }, queue email

POST /auth/reset-password { token, newPassword }
  → validate token (single use)
  → update passwordHash
  → revoke ALL session families for that user (AuditAction.SESSION_FAMILY_REVOKED)
  → queue PASSWORD_CHANGED email
```

**Team invitation** (no `Membership` exists until acceptance — the invitee may not have an
account yet):
```
POST /settings/team/members  { email, roleId }
  → QuotaGuard(SEATS) counts ACTIVE memberships + PENDING invitations against maxSeats
  → Invitation { status: PENDING, tokenHash, expiresAt: +7d }   (one PENDING per email per store)
  → emailQueue.add(SEND_EMAIL, { template: TEAM_INVITATION, data: { acceptUrl } })
  → MEMBER_INVITED

GET  /invitations/:token        → public preview: store name, role, inviter (nothing else)
POST /invitations/:token/accept → requires a logged-in user whose email matches (TENANT_INVITATION_EMAIL_MISMATCH otherwise)
  → Membership { status: ACTIVE, invitationId }, Invitation.status = ACCEPTED
  → MEMBER_JOINED → notify the inviter (NotificationTypes.INVITATION_ACCEPTED)

Nobody is added to a store without explicit consent.
```

**Transactional order emails:** triggered by domain events
(`ORDER_CREATED`, `ORDER_SHIPPED`, `ORDER_DELIVERED`, `ORDER_CANCELLED`), each queued with
the customer's locale and only when the customer has an email address.

### 5.4 Email analytics and bounces

Resend delivers one event per webhook call, signed via Svix. `resend@6` ships
`resend.webhooks.verify()` — no separate `svix` package.

```typescript
@Controller()
export class ResendWebhookController {
  @Post(ApiRoutes.webhooks.resend)
  @HttpCode(200)
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('svix-id') svixId: string,
    @Headers('svix-timestamp') svixTimestamp: string,
    @Headers('svix-signature') svixSignature: string,
  ): Promise<{ received: true }> {
    if (!req.rawBody || !env.RESEND_WEBHOOK_SECRET) {
      throw new PlatformException(ErrorCodes.AUTH_UNAUTHORIZED, 'Webhook not configured', 401)
    }

    const verified = this.resend.webhooks.verify({
      payload: req.rawBody.toString(),
      headers: { id: svixId, timestamp: svixTimestamp, signature: svixSignature },
      webhookSecret: env.RESEND_WEBHOOK_SECRET,
    })
    const event = resendWebhookEventSchema.parse(verified)     // Zod at the boundary; discriminated on `type`

    // Idempotency — Svix retries
    const fresh = await this.processedEvents.markOnce(WebhookSources.RESEND, svixId, event.type)
    if (!fresh) return { received: true }

    switch (event.type) {
      case ResendEventTypes.EMAIL_OPENED:
      case ResendEventTypes.EMAIL_CLICKED:
        if (event.data.tags.storeId) {
          await this.analyticsQueue.add(JobNames.TRACK_EVENT, {
            event: AnalyticsEventNames.EMAIL_ENGAGEMENT,
            storeId: event.data.tags.storeId,
            data: { type: event.type, template: event.data.tags.template, messageId: event.data.email_id },
            timestamp: new Date().toISOString(),
          })
        }
        break

      case ResendEventTypes.EMAIL_BOUNCED:
      case ResendEventTypes.EMAIL_FAILED:
        // Hard bounce/failure means the address is dead — for users AND customers
        await this.users.markEmailInvalid(event.data.to)
        await this.customers.markEmailInvalid(event.data.to)
        break

      case ResendEventTypes.EMAIL_COMPLAINED:
        this.logger.warn({ emailHash: hashEmail(event.data.to[0]) }, 'spam complaint received')
        break

      case ResendEventTypes.EMAIL_RECEIVED:                    // Inbound email channel, TDD_10 §5.5
        await this.inboundQueue.add(JobNames.PROCESS_CHANNEL_EVENT, this.emailChannel.toChannelEventJob(event))
        break
    }

    return { received: true }
  }
}
```

`ProcessedWebhookEventsService.markOnce` inserts the `(source, eventId)` row and returns
`false` on a unique violation — the row is written **only after** the handler succeeds by
running the insert and the handler inside one transaction; a thrown handler rolls the marker
back so the retry is processed.

### 5.5 Deliverability requirements

```
Before sending any production email:
- [ ] SPF record configured
- [ ] DKIM signing enabled and verified
- [ ] DMARC policy published (start p=none, move to p=quarantine)
- [ ] Dedicated sending subdomain (mail.platform.com) and inbound subdomain (inbound.platform.com, MX → Resend)
- [ ] Warm-up period respected for a new sending domain
- [ ] Unsubscribe link in every non-transactional email
- [ ] Plain-text alternative for every HTML email
- [ ] Bounce and complaint handling wired to the webhook above
```

---

## 6. File upload

### 6.1 Strategy: direct-to-S3 with pre-signed URLs, media first

Media is uploaded **before** the message, order or product that will reference it exists;
the `Media` row is created at confirmation with a `purpose` and is attached to its parent
by the parent's create/update call (`mediaIds: string[]` in the Zod schema).

```
Client                     Backend                    S3
  │                           │                        │
  ├── 1. request upload URL ──>│  (purpose, filename,   │
  │                           │   contentType, size)   │
  │                           ├── validate type/size    │
  │                           ├── build key (storage-keys.ts)
  │<── 2. { uploadUrl, key } ──┤                        │
  │                                                     │
  ├── 3. PUT file directly ────────────────────────────>│
  │<── 4. 200 OK ───────────────────────────────────────┤
  │                                                     │
  ├── 5. confirm upload ──────>│                        │
  │                           ├── HeadObject: exists, size matches
  │                           ├── create Media { status: PENDING, purpose }
  │                           ├── queue SCAN_FILE       │
  │<── 6. { mediaId } ─────────┤                        │
  │                                                     │
  ├── 7. POST /messages { mediaIds: [mediaId] } ───────>│  (or /orders, /products …)
```

Backend bandwidth is never consumed by file bytes.

### 6.2 Constraints

```typescript
// libs/core/storage/upload-constants.ts
export const UploadLimits = {
  MAX_FILE_SIZE_BYTES: 10 * 1024 * 1024,        // 10 MB
  MAX_VIDEO_SIZE_BYTES: 25 * 1024 * 1024,       // 25 MB
  PRESIGNED_URL_TTL_SECONDS: 300,               // 5 min
  DOWNLOAD_URL_TTL_SECONDS: 900,                // 15 min
  UNCONFIRMED_UPLOAD_TTL_HOURS: 24,             // Orphan objects without a Media row are deleted by cleanup
} as const

export const AllowedContentTypes = {
  IMAGE: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  VIDEO: ['video/mp4', 'video/quicktime'],
  AUDIO: ['audio/mpeg', 'audio/ogg', 'audio/wav'],
  DOCUMENT: ['application/pdf', 'text/plain',
             'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
             'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
} as const

export const AllAllowedContentTypes: ReadonlySet<string> = new Set(Object.values(AllowedContentTypes).flat())

export const MediaPurpose = {
  MESSAGE: 'message',
  PRODUCT: 'product',
  ORDER: 'order',
  AVATAR: 'avatar',
  EXPORT: 'export',
} as const
export type MediaPurposeType = typeof MediaPurpose[keyof typeof MediaPurpose]
```

```typescript
// libs/core/storage/storage-keys.ts — the ONLY place S3 keys are built (TDD_01 §2.3)
export const StorageKeys = {
  message: (storeId: string, mediaId: string, filename: string) => `stores/${storeId}/messages/${mediaId}/${filename}`,
  messageVariant: (storeId: string, mediaId: string, variant: ImageVariant) => `stores/${storeId}/messages/${mediaId}/variants/${variant}.webp`,
  product: (storeId: string, productId: string, mediaId: string, filename: string) => `stores/${storeId}/products/${productId}/${mediaId}/${filename}`,
  order: (storeId: string, orderId: string, mediaId: string, filename: string) => `stores/${storeId}/orders/${orderId}/${mediaId}/${filename}`,
  export: (storeId: string, exportId: string, filename: string) => `stores/${storeId}/exports/${exportId}/${filename}`,
  avatar: (userId: string, mediaId: string, filename: string) => `users/${userId}/avatar/${mediaId}/${filename}`,
  dsrExport: (requestId: string) => `compliance/dsr/${requestId}/export.zip`,
  auditArchive: (year: number, month: number) => `audit/${year}/${String(month).padStart(2, '0')}/audit-logs.jsonl.gz`,
  storePrefix: (storeId: string) => `stores/${storeId}/`,
} as const

export const ImageVariants = { FULL: 'full', MEDIUM: 'medium', THUMB: 'thumb' } as const
export type ImageVariant = typeof ImageVariants[keyof typeof ImageVariants]
```

### 6.3 Pre-signed URL generation

```typescript
@Controller()
export class MediaController {
  @Post(ApiRoutes.media.uploadUrl)
  @UseGuards(AuthGuard, TenantGuard, AccessLevelGuard, PermissionGuard)
  @RequirePermissions(Permissions.MEDIA_UPLOAD)
  async getUploadUrl(
    @CurrentStore() store: Store,
    @CurrentUser() user: User,
    @Body(new ZodValidationPipe(requestUploadUrlSchema)) input: RequestUploadUrlInput,
  ): Promise<UploadUrlResult> {
    if (!AllAllowedContentTypes.has(input.contentType)) {
      throw new PlatformException(ErrorCodes.FILE_TYPE_NOT_ALLOWED, 'File type not allowed', 400, { contentType: input.contentType })
    }

    const maxSize = (AllowedContentTypes.VIDEO as readonly string[]).includes(input.contentType)
      ? UploadLimits.MAX_VIDEO_SIZE_BYTES
      : UploadLimits.MAX_FILE_SIZE_BYTES

    if (input.fileSizeBytes > maxSize) {
      throw new PlatformException(ErrorCodes.FILE_TOO_LARGE, 'File too large', 400, { maxSizeBytes: maxSize })
    }

    return this.storage.generateUploadUrl({
      storeId: store.id,
      userId: user.id,
      purpose: input.purpose,                 // MediaPurpose; parentId required for PRODUCT/ORDER
      parentId: input.parentId,
      filename: sanitizeFilename(input.filename),
      contentType: input.contentType,
      contentLength: input.fileSizeBytes,
    })
  }
}
```

```typescript
// libs/core/storage/storage.service.ts
async generateUploadUrl(params: GenerateUploadUrlParams): Promise<UploadUrlResult> {
  const mediaId = randomUUID()             // Pre-allocated: it becomes Media.id on confirmation
  const key = this.keyFor(params, mediaId) // StorageKeys.<purpose>(…)

  const command = new PutObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: key,
    ContentType: params.contentType,
    ContentLength: params.contentLength,
    Metadata: { storeId: params.storeId ?? '', mediaId, originalFilename: params.filename },
  })

  // ContentType and ContentLength are part of the signature: S3 rejects a PUT whose
  // headers differ from the signed values, so the size limit holds at the edge.
  const uploadUrl = await getSignedUrl(this.s3, command, {
    expiresIn: UploadLimits.PRESIGNED_URL_TTL_SECONDS,
    signableHeaders: new Set(['content-type', 'content-length']),
  })

  return { uploadUrl, key, mediaId }
}
```

**Filename sanitization is mandatory** — prevents path traversal and command injection
through downstream processing. `sanitizeFilename` keeps `[A-Za-z0-9._-]`, collapses the
rest to `_`, and caps length at 120.

### 6.4 Client upload with progress

```typescript
export async function uploadFileWithProgress(
  storeId: string,
  file: File,
  context: { purpose: MediaPurposeType; parentId?: string },
  onProgress: (percent: number) => void
): Promise<string> {
  const { uploadUrl, key, mediaId } = await apiClient.media.getUploadUrl(storeId, {
    filename: file.name,
    contentType: file.type,
    fileSizeBytes: file.size,
    ...context
  })

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()

    xhr.upload.addEventListener('progress', e => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
    })
    xhr.addEventListener('load', () => (xhr.status === 200 ? resolve() : reject(new UploadError(ErrorCodes.FILE_UPLOAD_FAILED))))
    xhr.addEventListener('error', () => reject(new UploadError(ErrorCodes.FILE_UPLOAD_FAILED)))
    xhr.addEventListener('abort', () => reject(new UploadError(ErrorCodes.FILE_UPLOAD_FAILED)))

    xhr.open('PUT', uploadUrl)
    xhr.setRequestHeader('Content-Type', file.type)
    xhr.send(file)
  })

  const media = await apiClient.media.confirmUpload(storeId, {
    mediaId, key,
    filename: file.name,
    contentType: file.type,
    fileSizeBytes: file.size,
    ...context
  })

  return media.id
}
```

### 6.5 Post-upload processing

```typescript
@Post(ApiRoutes.media.confirmUpload)
@UseGuards(AuthGuard, TenantGuard, AccessLevelGuard, PermissionGuard)
@RequirePermissions(Permissions.MEDIA_UPLOAD)
async confirmUpload(
  @CurrentStore() store: Store,
  @CurrentUser() user: User,
  @Body(new ZodValidationPipe(confirmUploadSchema)) input: ConfirmUploadInput,
): Promise<MediaDto> {
  // The key MUST belong to this store — a foreign prefix is a cross-tenant attempt
  if (!input.key.startsWith(StorageKeys.storePrefix(store.id))) {
    throw new PlatformException(ErrorCodes.FILE_KEY_OUT_OF_SCOPE, 'Key outside store scope', 403)
  }

  // Verify the object actually exists and matches declared size and type
  const head = await this.storage.headObject(input.key)
  if (!head || head.contentLength !== input.fileSizeBytes || head.contentType !== input.contentType) {
    throw new PlatformException(ErrorCodes.FILE_UPLOAD_FAILED, 'Upload verification failed', 400)
  }

  const media = await this.prisma.client.media.create({
    data: {
      id: input.mediaId,                     // Pre-allocated in generateUploadUrl; key embeds it
      storeId: store.id,
      purpose: input.purpose,
      productId: input.purpose === MediaPurpose.PRODUCT ? input.parentId : null,
      orderId: input.purpose === MediaPurpose.ORDER ? input.parentId : null,
      uploadedBy: user.id,
      key: input.key,
      filename: sanitizeFilename(input.filename),
      contentType: input.contentType,
      fileSize: input.fileSizeBytes,
      status: MediaStatus.PENDING,
    }
  })

  // Scan first. PROCESS_IMAGE is enqueued by the scan job ONLY after a clean result.
  await this.heavyQueue.add(JobNames.SCAN_FILE, { mediaId: media.id })

  return toMediaDto(media)
}
```

**Virus scanning (ClamAV), then image processing:**
```typescript
// apps/worker/src/processors/heavy-processing.processor.ts
async scanFile(job: Job<ScanFileJob>): Promise<void> {
  const media = await this.prisma.client.media.findUniqueOrThrow({ where: { id: job.data.mediaId } })
  const { isInfected, viruses } = await this.virusScan.scan(media.key)   // clamscan over a streamed S3 object

  if (isInfected) {
    await this.storage.delete(media.key)
    await this.prisma.client.media.update({
      where: { id: media.id },
      data: { status: MediaStatus.INFECTED, scanResult: { viruses }, scannedAt: new Date() },
    })
    this.events.emit(Events.MEDIA_INFECTED, { storeId: media.storeId, mediaId: media.id, messageId: media.messageId })
    return   // Notification + security log via the MEDIA_INFECTED listener
  }

  await this.prisma.client.media.update({ where: { id: media.id }, data: { status: MediaStatus.CLEAN, scannedAt: new Date() } })

  if ((AllowedContentTypes.IMAGE as readonly string[]).includes(media.contentType)) {
    await this.heavyQueue.add(JobNames.PROCESS_IMAGE, { mediaId: media.id })
  }
  this.events.emit(Events.MEDIA_PROCESSED, { storeId: media.storeId, mediaId: media.id })
}

async processImage(job: Job<ProcessImageJob>): Promise<void> {
  const media = await this.prisma.client.media.findUniqueOrThrow({ where: { id: job.data.mediaId } })
  if (media.status !== MediaStatus.CLEAN || !media.storeId) return

  const original = await this.storage.download(media.key)

  const [full, medium, thumb] = await Promise.all([
    sharp(original).resize(2000, 2000, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer(),
    sharp(original).resize(800, null, { withoutEnlargement: true }).webp({ quality: 80 }).toBuffer(),
    sharp(original).resize(160, 160, { fit: 'cover' }).webp({ quality: 70 }).toBuffer(),
  ])

  // Variants are stored as KEYS and signed at read time — never as URLs
  const keys = {
    [ImageVariants.FULL]: StorageKeys.messageVariant(media.storeId, media.id, ImageVariants.FULL),
    [ImageVariants.MEDIUM]: StorageKeys.messageVariant(media.storeId, media.id, ImageVariants.MEDIUM),
    [ImageVariants.THUMB]: StorageKeys.messageVariant(media.storeId, media.id, ImageVariants.THUMB),
  }
  await Promise.all([
    this.storage.upload(full, keys.full, 'image/webp'),
    this.storage.upload(medium, keys.medium, 'image/webp'),
    this.storage.upload(thumb, keys.thumb, 'image/webp'),
  ])

  await this.prisma.client.media.update({ where: { id: media.id }, data: { variants: keys, processedAt: new Date() } })
}
```

**Inbound channel media** (`FetchInboundMediaJob`, enqueued by the inbound pipeline,
`TDD_10` §4): the worker downloads the provider's media through the plugin
(`plugin.fetchMedia(connection, mediaRef)` — WhatsApp media URLs expire and need the
connection's token), writes it to `StorageKeys.message(...)`, creates the `Media` row with
`purpose: MESSAGE`, `messageId` and `customerId`, and enqueues `SCAN_FILE`. The message
renders a placeholder until the media is `CLEAN`.

Media with `status !== CLEAN` is never served to clients (`FILE_NOT_READY` / `FILE_INFECTED`).

### 6.6 Download

```typescript
// Private files are always served via short-lived signed URLs on the bucket host
@Get(ApiRoutes.media.byId(':id'))
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
@RequirePermissions(Permissions.MEDIA_VIEW)
async getMedia(@Param('id') id: string, @CurrentStore() store: Store): Promise<MediaUrlsDto> {
  const media = await this.prisma.client.media.findFirst({ where: { id, storeId: store.id } })   // Tenant scoped

  if (!media) throw new PlatformException(ErrorCodes.RESOURCE_NOT_FOUND, 'Media not found', 404)
  if (media.status === MediaStatus.INFECTED) throw new PlatformException(ErrorCodes.FILE_INFECTED, 'File unavailable', 403)
  if (media.status !== MediaStatus.CLEAN) throw new PlatformException(ErrorCodes.FILE_NOT_READY, 'File is being scanned', 409)

  const variants = mediaVariantsSchema.parse(media.variants ?? {})   // JSON boundary
  const ttl = UploadLimits.DOWNLOAD_URL_TTL_SECONDS

  return {
    url: await this.storage.getSignedDownloadUrl(media.key, ttl),
    filename: media.filename,
    contentType: media.contentType,
    variants: {
      full:   variants.full   ? await this.storage.getSignedDownloadUrl(variants.full, ttl)   : null,
      medium: variants.medium ? await this.storage.getSignedDownloadUrl(variants.medium, ttl) : null,
      thumb:  variants.thumb  ? await this.storage.getSignedDownloadUrl(variants.thumb, ttl)  : null,
    },
  }
}
```

Signed URLs point at the bucket host; there is no public CDN hostname for private media
(`TDD_08` §3).

**Bulk download** (media gallery "Download all"): creates an `Export { type: MEDIA_ZIP }`
and enqueues `GENERATE_MEDIA_ZIP` on the exports queue (§7); delivery is an `EXPORT_READY`
notification.

---

## 7. Export generation

```typescript
// apps/worker/src/processors/export.processor.ts
import { format as formatDate } from 'date-fns'

async generateExport(job: Job<GenerateExportJob>): Promise<void> {
  const exp = await this.prisma.client.export.findUniqueOrThrow({ where: { id: job.data.exportId } })
  const { storeId, requestedBy, type, filters } = exp
  const exportFormat = exp.format as ExportFormat          // Validated at creation by Zod

  const filename = `${type}-${formatDate(new Date(), 'yyyy-MM-dd')}.${exportFormat}`
  const key = StorageKeys.export(storeId, exp.id, filename)

  // Stream rows into the file writer; never materialize the full result set
  const rows = this.exportRows.stream(type as ExportType, storeId, filters)      // AsyncIterable<Record<string, unknown>>
  const { rowCount } = await this.writers[exportFormat].writeToStorage(rows, key, { tags: { purpose: MediaPurpose.EXPORT } })

  await this.prisma.client.export.update({
    where: { id: exp.id },
    data: { status: ExportStatus.READY, key, rowCount, completedAt: new Date() },
  })

  await this.notifications.send({
    userId: requestedBy,
    storeId,
    type: NotificationTypes.EXPORT_READY,
    params: { filename, type },
    resourceType: 'export',
    resourceId: exp.id,
    actionPath: AppPaths.store.exportDownload(storeId, exp.id),
  })

  this.audit.log({
    action: ExportAuditActions[type as ExportType],     // CUSTOMER_EXPORTED, CONVERSATION_EXPORTED, ORDER_EXPORTED, …
    actor: { userId: requestedBy },
    storeId,
    resourceType: 'export',
    resourceId: exp.id,
    metadata: { type, format: exportFormat, rowCount },
  })
}
```

`ExportAuditActions` maps every `ExportType` to its `AuditAction`. Exports expire after 14
days (`Export.expiresAt`, cleanup in `TDD_05` §10.4). Exports are always audited — they are
bulk data egress.

---

## 8. Queue observability

Covered in `TDD_04_Observability.md` §2.4 and §6. Key signals:

```
platform_queue_depth{queue, state}            — backlog per queue
platform_queue_processed_total{queue, job}    — throughput
platform_queue_failed_total{queue, job}       — failure rate
platform_queue_processing_duration_seconds    — job latency
```

Alerts fire on: depth > 1000 for 5m, failure rate > 0.1/s for 2m,
backlog with zero throughput for 10m (stalled worker), and a non-empty DLQ for 30m.
