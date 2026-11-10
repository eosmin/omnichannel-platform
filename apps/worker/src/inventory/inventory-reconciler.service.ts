import { Injectable } from '@nestjs/common'
import type { Counter } from '@prometheus-io/client'
import { PinoLogger } from 'nestjs-pino'

import { PrismaService } from '@platform/core/database'
import { InventoryLimits } from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import { InventoryService, type LevelCheck } from '@platform/core/inventory'
import { MetricNames } from '@platform/core/metrics'
import { InjectMetric } from '@platform/core/metrics-module'

export interface ReconcileReport {
  levelsChecked: number
  // Levels whose on hand, reserved or value differ from what their ledger says
  mismatches: number
  // Levels below zero in a store that does not allow negative stock (TDD_16 §4.8), whether or not the ledger agrees
  negativeNotAllowed: number
  // Items that could not be checked (a lock timeout, a dropped connection): logged, and the rest of the store goes on
  failed: number
}

export interface ReconcileOptions {
  pageSize?: number
}

interface ItemKey {
  productId: string
  variantId: string | null
  warehouseId: string
}

// The daily check of the stock of one store (TDD_16 §4.8): each level is compared with what its own ledger says it
// must be (`InventoryService.checkLevel`), and what does not agree is counted and logged with both values. It READS
// only: the owner decides through a count or an adjustment, so nothing here writes a level or a movement (the lint
// ban of libs/core/inventory would refuse it too). Every read names the store of the job.
@Injectable()
export class InventoryReconciler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    @InjectMetric(MetricNames.INVENTORY_RECONCILIATION_MISMATCHES)
    private readonly mismatchCounter: Counter<string>,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(InventoryReconciler.name)
  }

  async reconcileStore(storeId: string, options: ReconcileOptions = {}): Promise<ReconcileReport> {
    const pageSize = options.pageSize ?? InventoryLimits.RECONCILE_PAGE_SIZE
    const settings = await this.prisma.client.storeSettings.findUnique({
      where: { storeId },
      select: { allowNegativeStock: true }
    })
    const allowNegativeStock = settings?.allowNegativeStock ?? false
    const report: ReconcileReport = {
      levelsChecked: 0,
      mismatches: 0,
      negativeNotAllowed: 0,
      failed: 0
    }

    // The levels the table has, in pages by id
    let cursor: string | undefined
    for (;;) {
      const page = await this.prisma.client.inventoryLevel.findMany({
        where: { storeId },
        select: { id: true, productId: true, variantId: true, warehouseId: true },
        orderBy: { id: 'asc' },
        take: pageSize,
        ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 })
      })
      for (const level of page) {
        await this.check(storeId, level, allowNegativeStock, report)
      }
      if (page.length < pageSize) break
      cursor = page.at(-1)?.id
    }

    // The items that have a ledger and no level: a level that was deleted is the same disagreement
    let skip = 0
    for (;;) {
      const page = await this.prisma.client.inventoryMovement.groupBy({
        by: ['productId', 'variantId', 'warehouseId'],
        where: { storeId },
        orderBy: [{ productId: 'asc' }, { variantId: 'asc' }, { warehouseId: 'asc' }],
        take: pageSize,
        skip
      })
      // Which of this page have a level: one read for the page, not a set of the whole store
      const levels = await this.prisma.client.inventoryLevel.findMany({
        where: {
          storeId,
          productId: { in: page.map(item => item.productId) },
          warehouseId: { in: page.map(item => item.warehouseId) }
        },
        select: { productId: true, variantId: true, warehouseId: true }
      })
      const withLevel = new Set(levels.map(keyOf))
      for (const item of page) {
        if (withLevel.has(keyOf(item))) continue
        await this.check(storeId, item, allowNegativeStock, report)
      }
      if (page.length < pageSize) break
      skip += pageSize
    }
    return report
  }

  private async check(
    storeId: string,
    item: ItemKey,
    allowNegativeStock: boolean,
    report: ReconcileReport
  ): Promise<void> {
    let check: LevelCheck
    try {
      check = await this.inventory.checkLevel({ storeId, ...item })
    } catch (error) {
      // One item that cannot be read must not hide the rest of the store: it is told, and counted apart
      report.failed += 1
      this.logger.error(
        { storeId, ...item, errorName: errorName(error) },
        'a stock level could not be checked'
      )
      return
    }
    report.levelsChecked += 1
    const mismatch = !check.matches
    const negative = !allowNegativeStock && check.actual.onHand < 0
    if (mismatch) report.mismatches += 1
    if (negative) report.negativeNotAllowed += 1
    if (!mismatch && !negative) return
    this.mismatchCounter.inc({ store_id: storeId })
    this.logger.warn(
      {
        storeId,
        ...item,
        mismatch,
        negativeNotAllowed: negative,
        actual: show(check.actual),
        expected: show(check.expected)
      },
      mismatch
        ? 'a stock level does not match its ledger'
        : 'a stock level is negative and the store does not allow it'
    )
  }
}

const keyOf = (item: ItemKey): string =>
  `${item.productId}|${item.variantId ?? ''}|${item.warehouseId}`

// BigInt does not go into a log line as it is
function show(values: LevelCheck['actual']): {
  onHand: number
  reserved: number
  valueCents: string
} {
  return { ...values, valueCents: values.valueCents.toString() }
}
