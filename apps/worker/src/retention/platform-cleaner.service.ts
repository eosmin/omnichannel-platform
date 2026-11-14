import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { DataRetentionPolicies, PlatformCleanup } from '@platform/core/compliance'
import { PrismaService } from '@platform/core/database'
import { DAY_MS } from '@platform/core/domain'
import { errorName } from '@platform/core/errors'

import { categoryRunner, inBatches } from './retention-batches'

export interface PlatformCleanupReport {
  sessions: number
  verificationTokens: number
  webhookDeliveries: number
  metricsHourly: number
  mergedCustomers: number
  // The categories that stopped on a full batch: tomorrow takes the rest
  more: string[]
}

type Category = Exclude<keyof PlatformCleanupReport, 'more'>

// What is not a store's to configure (TDD_05 §10.4, daily): the sessions past expiresAt (a consumed row stays until then,
// because reuse detection needs it), the verification tokens that are expired or were used a day ago, the deliveries of the
// webhooks past thirty days, the hours of the hourly rollup past ninety days, and the customers a merge
// absorbed whose window to undo it (`unmergeUntil`) has passed, with their CustomerMerge row (the audit log keeps
// `customer.merged`). Platform-wide, in batches of PlatformCleanup.BATCH_SIZE; each row is deleted by its own id, so
// no store is read as a whole. A category that fails does not stop the others.
@Injectable()
export class PlatformCleaner {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger
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
    await run('webhookDeliveries', () =>
      this.batches(
        () => this.prisma.client.$executeRaw`
          DELETE FROM webhook_deliveries WHERE id IN (
            SELECT id FROM webhook_deliveries
            WHERE created_at < (${webhookCutoff}::timestamptz AT TIME ZONE 'UTC')
            ORDER BY created_at LIMIT ${PlatformCleanup.BATCH_SIZE})`
      )
    )
    await run('metricsHourly', () =>
      this.batches(
        () => this.prisma.client.$executeRaw`
          DELETE FROM metrics_hourly WHERE id IN (
            SELECT id FROM metrics_hourly
            WHERE hour < (${hourlyCutoff}::timestamptz AT TIME ZONE 'UTC')
            ORDER BY hour LIMIT ${PlatformCleanup.BATCH_SIZE})`
      )
    )
    await run('mergedCustomers', () => this.mergedCustomers(now))

    this.logger.info(report, 'the platform cleanup finished')
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

  // A merge past its window: the absorbed customer goes, then the row of the merge. Only a customer that is still
  // absorbed (`mergedIntoId` set) is deleted: one that an undo brought back, or that nobody absorbed, is a live
  // customer and stays, and its merge row (already `unmergedAt`) is only history. A customer the database will not
  // delete (a conversation or an order still points to it) is left, said in the log, and tried again tomorrow; the
  // walk by id lets the rest of the batch go on past it.
  private async mergedCustomers(now: Date) {
    let after = ''
    let deleted = 0
    let more = false
    for (let batch = 0; batch < PlatformCleanup.MAX_BATCHES; batch += 1) {
      const merges = await this.prisma.client.customerMerge.findMany({
        where: { unmergeUntil: { lt: now }, id: { gt: after } },
        select: { id: true, storeId: true, absorbedId: true, unmergedAt: true },
        orderBy: { id: 'asc' },
        take: PlatformCleanup.BATCH_SIZE
      })
      for (const merge of merges) {
        try {
          // What the cleanup removed: the customer it deleted, or the row of a merge it closed. A customer that is
          // already gone, or live, adds nothing
          deleted += await this.prisma.transaction(async tx => {
            let removed = 0
            if (merge.unmergedAt === null) {
              const customers = await tx.customer.deleteMany({
                where: {
                  id: merge.absorbedId,
                  storeId: merge.storeId,
                  mergedIntoId: { not: null }
                }
              })
              removed = customers.count
            }
            const rows = await tx.customerMerge.deleteMany({
              where: { id: merge.id, storeId: merge.storeId }
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
