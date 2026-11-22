import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import {
  DataRetentionPolicies,
  PlatformCleanup,
  RetentionResourceTypes
} from '@platform/core/compliance'
import { JobContext, PrismaService } from '@platform/core/database'
import { DAY_MS, InvitationStatus, PluginInstallationStatus } from '@platform/core/domain'
import { errorName } from '@platform/core/errors'

import { inEachStoreStrict } from '../schedulers/store-sweep'

import { type BatchOutcome, categoryRunner, inBatches, PartialRunError } from './retention-batches'
import { runAuditMetadata, runHasNews } from './run-audit'

// rls-context: sessions, verification_tokens and invitations are global tables (invitations is skipped by the RLS migrations); every other table runs inside JobContext.forStore of its store

export interface PlatformCleanupReport {
  sessions: number
  verificationTokens: number
  webhookDeliveries: number
  metricsHourly: number
  mergedCustomers: number
  invitations: number
  revokedPluginSecrets: number
  pluginIdempotencyKeys: number
  // The categories that stopped on a full batch: tomorrow takes the rest
  more: string[]
}

type Category = Exclude<keyof PlatformCleanupReport, 'more'>

// What is not a store's to configure (TDD_05 §10.4, daily): the sessions past expiresAt (a consumed row stays until then,
// because reuse detection needs it), the verification tokens that are expired or were used a day ago, the deliveries of the
// webhooks past thirty days, the hours of the hourly rollup past ninety days, the idempotency keys of the plugin API past their day, and the customers a merge
// absorbed whose window to undo it (`unmergeUntil`) has passed, with their CustomerMerge row (the audit log keeps
// `customer.merged`), and the invitations that nobody accepted and that expired more than
// `PlatformCleanup.EXPIRED_INVITATION_GRACE_DAYS` ago, and the sealed secrets and the endpoint that a plugin installation revoked more than
// `PlatformCleanup.REVOKED_PLUGIN_SECRET_GRACE_DAYS` ago still holds (a revoked row without `revoked_at` counts from its `updated_at`). Platform-wide, in batches of PlatformCleanup.BATCH_SIZE; each row is deleted by its own id, so
// no store is read as a whole. A category that fails does not stop the others.
@Injectable()
export class PlatformCleaner {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobContext: JobContext,
    private readonly logger: PinoLogger,
    private readonly audit: AuditService
  ) {
    this.logger.setContext(PlatformCleaner.name)
  }

  async run(now: Date = new Date()): Promise<PlatformCleanupReport> {
    const stamp = now.toISOString()
    const report: PlatformCleanupReport = {
      sessions: 0,
      verificationTokens: 0,
      webhookDeliveries: 0,
      metricsHourly: 0,
      mergedCustomers: 0,
      invitations: 0,
      revokedPluginSecrets: 0,
      pluginIdempotencyKeys: 0,
      more: []
    }
    const failed: Category[] = []
    const run = categoryRunner(report, failed, (category, error) => {
      this.logger.error(
        { category, errorName: errorName(error) },
        'a category of the platform cleanup failed'
      )
    })
    const webhookCutoff = new Date(
      now.getTime() - DataRetentionPolicies.WEBHOOK_DELIVERIES.defaultDays * DAY_MS
    ).toISOString()
    const usedTokenCutoff = new Date(
      now.getTime() - PlatformCleanup.USED_TOKEN_GRACE_DAYS * DAY_MS
    ).toISOString()
    const hourlyCutoff = new Date(
      now.getTime() - DataRetentionPolicies.METRICS_HOURLY.defaultDays * DAY_MS
    ).toISOString()

    const invitationCutoff = new Date(
      now.getTime() - PlatformCleanup.EXPIRED_INVITATION_GRACE_DAYS * DAY_MS
    ).toISOString()

    const revokedPluginCutoff = new Date(
      now.getTime() - PlatformCleanup.REVOKED_PLUGIN_SECRET_GRACE_DAYS * DAY_MS
    ).toISOString()

    await run('sessions', () =>
      this.batches(
        () => this.prisma.client.$executeRaw`
          DELETE FROM sessions WHERE id IN (
            SELECT id FROM sessions
            WHERE expires_at < (${stamp}::timestamptz AT TIME ZONE 'UTC')
            ORDER BY expires_at LIMIT ${PlatformCleanup.BATCH_SIZE})`
      )
    )
    await run('verificationTokens', async () => {
      // Two statements, each on what it can find fast: the expired by their index, the used by their date
      const expired = await this.batches(
        () => this.prisma.client.$executeRaw`
          DELETE FROM verification_tokens WHERE id IN (
            SELECT id FROM verification_tokens
            WHERE expires_at < (${stamp}::timestamptz AT TIME ZONE 'UTC')
            ORDER BY expires_at LIMIT ${PlatformCleanup.BATCH_SIZE})`
      )
      const used = await this.batches(
        () => this.prisma.client.$executeRaw`
          DELETE FROM verification_tokens WHERE id IN (
            SELECT id FROM verification_tokens
            WHERE used_at < (${usedTokenCutoff}::timestamptz AT TIME ZONE 'UTC')
            LIMIT ${PlatformCleanup.BATCH_SIZE})`
      )
      return { deleted: expired.deleted + used.deleted, more: expired.more || used.more }
    })
    // The rows of a store are deleted in the context of that store (the policies answer nothing else); a store that cannot be
    // entered stops the category, which the run reports as failed
    await run('webhookDeliveries', () =>
      this.perStore(
        storeId => this.prisma.client.$executeRaw`
          DELETE FROM webhook_deliveries WHERE id IN (
            SELECT id FROM webhook_deliveries
            WHERE created_at < (${webhookCutoff}::timestamptz AT TIME ZONE 'UTC')
              AND (webhook_id IN (SELECT id FROM webhooks WHERE store_id = ${storeId})
                OR plugin_installation_id IN (SELECT id FROM plugin_installations WHERE store_id = ${storeId}))
            ORDER BY created_at LIMIT ${PlatformCleanup.BATCH_SIZE})`
      )
    )
    await run('metricsHourly', () =>
      this.perStore(
        storeId => this.prisma.client.$executeRaw`
          DELETE FROM metrics_hourly WHERE id IN (
            SELECT id FROM metrics_hourly
            WHERE store_id = ${storeId} AND hour < (${hourlyCutoff}::timestamptz AT TIME ZONE 'UTC')
            ORDER BY hour LIMIT ${PlatformCleanup.BATCH_SIZE})`
      )
    )
    await run('mergedCustomers', () => this.mergedCustomers(now))
    // The answers a plugin can still get again (Step 7.3 S4) last PluginIdempotency.TTL_HOURS; the one that is past its date holds
    // the answer of a write, which can carry customer data, and goes
    await run('pluginIdempotencyKeys', () =>
      this.perStore(
        storeId => this.prisma.client.$executeRaw`
          DELETE FROM plugin_idempotency_keys WHERE id IN (
            SELECT id FROM plugin_idempotency_keys
            WHERE store_id = ${storeId} AND expires_at < (${stamp}::timestamptz AT TIME ZONE 'UTC')
            ORDER BY expires_at LIMIT ${PlatformCleanup.BATCH_SIZE})`
      )
    )
    // `invitations` is outside RLS (the migrations skip it), so it runs platform-wide like the sessions: a store that
    // cannot be entered does not stop it
    await run('invitations', () =>
      this.batches(
        () => this.prisma.client.$executeRaw`
          DELETE FROM invitations WHERE id IN (
            SELECT id FROM invitations
            WHERE status IN (${InvitationStatus.PENDING}, ${InvitationStatus.EXPIRED})
              AND expires_at < (${invitationCutoff}::timestamptz AT TIME ZONE 'UTC')
            ORDER BY expires_at LIMIT ${PlatformCleanup.BATCH_SIZE})`
      )
    )

    // The secrets that a revoked installation still holds: the sealed secret and the endpoint of its webhooks and the sealed secrets of its commands.
    // Only a row that is revoked, revoked longer ago than the grace and still holding one of them (so a batch that is done stops matching and the
    // loop ends); the outer WHERE repeats the predicate, so an installation that was installed again between the select and the update (status and
    // `revoked_at` change, new secrets) is never cleared by the batch that selected it. Nothing is read of the secrets, only set to NULL.
    await run('revokedPluginSecrets', () =>
      this.perStore(
        storeId => this.prisma.client.$executeRaw`
          UPDATE plugin_installations SET
            webhook_endpoint = NULL, webhook_secret = NULL,
            command_secret = NULL, command_secret_previous = NULL, command_secret_rotated_at = NULL,
            updated_at = (${stamp}::timestamptz AT TIME ZONE 'UTC')
          WHERE store_id = ${storeId}
            AND status = ${PluginInstallationStatus.REVOKED}
            AND COALESCE(revoked_at, updated_at) < (${revokedPluginCutoff}::timestamptz AT TIME ZONE 'UTC')
            AND id IN (
              SELECT id FROM plugin_installations
              WHERE store_id = ${storeId}
                AND status = ${PluginInstallationStatus.REVOKED}
                AND COALESCE(revoked_at, updated_at) < (${revokedPluginCutoff}::timestamptz AT TIME ZONE 'UTC')
                AND (webhook_endpoint IS NOT NULL OR webhook_secret IS NOT NULL
                  OR command_secret IS NOT NULL OR command_secret_previous IS NOT NULL)
              ORDER BY COALESCE(revoked_at, updated_at) LIMIT ${PlatformCleanup.BATCH_SIZE})`
      )
    )

    this.logger.info(report, 'the platform cleanup finished')
    // One entry for the run. It runs over every store, so it has no store (and no organization): the viewer of one store never reads
    // it, by design; it is there for the operator and the cold export
    const metadata = runAuditMetadata(report, report.more, failed)
    if (runHasNews(metadata)) {
      this.audit.log({
        action: AuditAction.PLATFORM_CLEANUP_RUN,
        actor: { system: true },
        resourceType: RetentionResourceTypes.PLATFORM,
        metadata
      })
    }
    if (report.more.length > 0) {
      this.logger.warn({ more: report.more }, 'a full batch was deleted; more waits')
    }
    if (failed.length > 0) throw new Error(`the platform cleanup failed for ${failed.join(', ')}`)
    return report
  }

  private batches(deleteBatch: () => Promise<number>) {
    return inBatches(PlatformCleanup.BATCH_SIZE, PlatformCleanup.MAX_BATCHES, async () => {
      const deleted = await deleteBatch()
      return { taken: deleted, deleted }
    })
  }

  // One category, store by store: each store's batches run in its own context, and the sum is the category's outcome. A store that
  // fails stops the category (what was deleted so far stays in the report).
  private async perStore(deleteBatch: (storeId: string) => Promise<number>): Promise<BatchOutcome> {
    let deleted = 0
    let more = false
    try {
      await inEachStoreStrict(this.prisma, async storeId => {
        const outcome = await inBatches(
          PlatformCleanup.BATCH_SIZE,
          PlatformCleanup.MAX_BATCHES,
          async () => {
            const removed = await this.jobContext.forStore(storeId, () => deleteBatch(storeId))
            return { taken: removed, deleted: removed }
          }
        )
        deleted += outcome.deleted
        more = more || outcome.more
      })
    } catch (error) {
      // The inner batches already counted what the failing store deleted: add it and keep the real cause
      const inner = error instanceof PartialRunError ? error : undefined
      const total = deleted + (inner?.deleted ?? 0)
      throw total > 0 ? new PartialRunError(total, inner?.original ?? error) : error
    }
    return { deleted, more }
  }

  // A merge past its window: the absorbed customer goes, then the row of the merge. Only a customer that is still
  // absorbed (`mergedIntoId` set) is deleted: one that an undo brought back, or that nobody absorbed, is a live
  // customer and stays, and its merge row (already `unmergedAt`) is only history. A customer the database will not
  // delete (a conversation or an order still points to it) is left, said in the log, and tried again tomorrow; the
  // walk by id lets the rest of the batch go on past it.
  private async mergedCustomers(now: Date): Promise<BatchOutcome> {
    let deleted = 0
    let more = false
    try {
      await inEachStoreStrict(this.prisma, async storeId => {
        const outcome = await this.mergedCustomersOfStore(storeId, now)
        deleted += outcome.deleted
        more = more || outcome.more
      })
    } catch (error) {
      // The inner batches already counted what the failing store deleted: add it and keep the real cause
      const inner = error instanceof PartialRunError ? error : undefined
      const total = deleted + (inner?.deleted ?? 0)
      throw total > 0 ? new PartialRunError(total, inner?.original ?? error) : error
    }
    return { deleted, more }
  }

  private async mergedCustomersOfStore(storeId: string, now: Date): Promise<BatchOutcome> {
    let after = ''
    let deleted = 0
    let more = false
    for (let batch = 0; batch < PlatformCleanup.MAX_BATCHES; batch += 1) {
      const merges = await this.jobContext.forStore(storeId, () =>
        this.prisma.client.customerMerge.findMany({
          where: { storeId, unmergeUntil: { lt: now }, id: { gt: after } },
          select: { id: true, storeId: true, absorbedId: true, unmergedAt: true },
          orderBy: { id: 'asc' },
          take: PlatformCleanup.BATCH_SIZE
        })
      )
      for (const merge of merges) {
        try {
          // One context for each merge: a customer the database refuses to delete fails its own transaction, and the rest go on
          deleted += await this.jobContext.forStore(storeId, async () => {
            let removed = 0
            if (merge.unmergedAt === null) {
              const customers = await this.prisma.client.customer.deleteMany({
                where: { id: merge.absorbedId, storeId, mergedIntoId: { not: null } }
              })
              removed = customers.count
            }
            const rows = await this.prisma.client.customerMerge.deleteMany({
              where: { id: merge.id, storeId }
            })
            return merge.unmergedAt === null ? removed : rows.count
          })
        } catch (error) {
          this.logger.warn(
            { mergeId: merge.id, errorName: errorName(error) },
            'a merge past its window could not be cleaned up'
          )
        }
      }
      after = merges.at(-1)?.id ?? after
      if (merges.length < PlatformCleanup.BATCH_SIZE) return { deleted, more: false }
      more = true
    }
    return { deleted, more }
  }
}
