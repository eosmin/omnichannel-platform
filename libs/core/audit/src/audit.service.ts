import { Inject, Injectable, type OnModuleDestroy, Optional } from '@nestjs/common'
import type { Counter } from '@prometheus-io/client'
import { PinoLogger } from 'nestjs-pino'

import type { AuditActionType } from '@platform/core/audit'
import { PrismaService } from '@platform/core/database'
import { MetricNames } from '@platform/core/metrics'
import { getMetricToken } from '@platform/core/metrics-module'

// Who did it. A worker, a webhook or the seed has no user. (Staff do not exist in the MVP.)
export type AuditActor = { userId: string } | { system: true }

export interface AuditEntry {
  action: AuditActionType
  actor: AuditActor
  storeId?: string
  organizationId?: string // Org-level actions with no single store
  resourceType?: string
  resourceId?: string
  metadata?: Record<string, unknown>
  ipAddress?: string
  userAgent?: string
}

// What the columns hold. A caller controls some of these values (a header, a path parameter), so
// none of them may grow the row without bound.
const MAX_USER_AGENT = 255
const MAX_IP_ADDRESS = 45 // The longest textual IPv6 address
const MAX_RESOURCE_TYPE = 64
const MAX_RESOURCE_ID = 255
const MAX_METADATA_BYTES = 8192
// Writes wait in memory until they finish. A database that stops answering must not take the
// process down with them: past this many, entries are refused, counted and logged.
const MAX_PENDING = 1000
// Writes that hold a connection of their own at once (see write)
const MAX_DETACHED_WRITES = 4

export const AUDIT_FAILURE_REASONS = {
  WRITE_FAILED: 'write_failed',
  QUEUE_FULL: 'queue_full'
} as const

function cut(value: string | undefined, max: number): string | undefined {
  return value === undefined ? undefined : value.slice(0, max)
}

// The audit log is the trail of who did what. A write never blocks the request and never throws at
// the caller (an action that was done must not fail because its record could not be written), but it
// is never silently lost either: a failure is logged and counted.
@Injectable()
export class AuditService implements OnModuleDestroy {
  private readonly pending = new Set<Promise<void>>()
  private detached = 0
  private readonly waiting: Array<() => void> = []

  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
    @Optional()
    @Inject(getMetricToken(MetricNames.AUDIT_WRITE_FAILURES))
    private readonly failures?: Counter<string>
  ) {
    this.logger.setContext(AuditService.name)
  }

  log(entry: AuditEntry): void {
    if (this.pending.size >= MAX_PENDING) {
      this.fail(AUDIT_FAILURE_REASONS.QUEUE_FULL, entry.action)
      return
    }
    const write: Promise<void> = this.write(entry)
      .catch((error: unknown) => {
        this.fail(AUDIT_FAILURE_REASONS.WRITE_FAILED, entry.action, error)
      })
      .finally(() => this.pending.delete(write))
    this.pending.add(write)
  }

  // A shutdown waits for the writes in flight (graceful stop of the process)
  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled(this.pending)
  }

  private async write(entry: AuditEntry): Promise<void> {
    // Inside the tenant transaction of a request whose context already holds the store of the entry (or an entry with no store),
    // the entry goes in that transaction: no second connection, and it sees what the request wrote (an entry about a row the
    // request has just created, with a foreign key to it, is not refused). Without RLS this is what it always did.
    const current = this.prisma.currentTenantContext()
    if (
      current !== undefined &&
      (entry.storeId === undefined || current.storeIds.includes(entry.storeId))
    ) {
      await this.prisma.client.auditLog.createMany({ data: [toRow(entry)] })
      return
    }
    // Everything else (a guard, a public route, a request that audits a store it is not in) runs in a tenant transaction of its
    // own, outside any request transaction, with the store of the entry as its whole context: the policy of audit_logs lets a
    // row in with no store or with a store of the context, so the trail of a login, of a refused key or of a request for a store
    // the person does not belong to is never refused. Without RETURNING (createMany): a returned row would also have to pass the
    // SELECT policy. At most MAX_DETACHED_WRITES at a time: a burst of denials must not take the pool from the requests.
    await this.acquire()
    try {
      await this.prisma.detachedTenantTransaction(
        { storeIds: entry.storeId === undefined ? [] : [entry.storeId], organizationIds: [] },
        async () => {
          await this.prisma.client.auditLog.createMany({ data: [toRow(entry)] })
        }
      )
    } finally {
      this.release()
    }
  }

  private async acquire(): Promise<void> {
    if (this.detached < MAX_DETACHED_WRITES) {
      this.detached += 1
      return
    }
    await new Promise<void>(resolve => this.waiting.push(resolve))
  }

  private release(): void {
    const next = this.waiting.shift()
    // The slot passes to the next writer in line; with none waiting it is free
    if (next === undefined) this.detached -= 1
    else next()
  }

  private fail(reason: string, action: AuditActionType, error?: unknown): void {
    this.failures?.inc({ reason })
    this.logger.error(
      { action, reason, err: error instanceof Error ? error.message : undefined },
      'an audit entry could not be written'
    )
  }
}

export function toRow(entry: AuditEntry): {
  action: string
  userId: string | null
  storeId: string | null
  organizationId: string | null
  resourceType: string | null
  resourceId: string | null
  metadata: object | undefined
  ipAddress: string | null
  userAgent: string | null
} {
  return {
    action: entry.action,
    userId: 'userId' in entry.actor ? entry.actor.userId : null,
    storeId: entry.storeId ?? null,
    organizationId: entry.organizationId ?? null,
    resourceType: cut(entry.resourceType, MAX_RESOURCE_TYPE) ?? null,
    resourceId: cut(entry.resourceId, MAX_RESOURCE_ID) ?? null,
    metadata: boundedMetadata(entry.metadata),
    ipAddress: cut(entry.ipAddress, MAX_IP_ADDRESS) ?? null,
    userAgent: cut(entry.userAgent, MAX_USER_AGENT) ?? null
  }
}

// JSON that fits. What does not (too big, a cycle, a BigInt) is replaced by a note that says so,
// so the entry is still written.
function boundedMetadata(metadata: Record<string, unknown> | undefined): object | undefined {
  if (metadata === undefined) return undefined
  let json: string
  try {
    json = JSON.stringify(metadata)
  } catch {
    return { unserializable: true }
  }
  if (Buffer.byteLength(json) > MAX_METADATA_BYTES) {
    return { truncated: true, bytes: Buffer.byteLength(json) }
  }
  return JSON.parse(json) as object // The text was just produced by JSON.stringify
}
