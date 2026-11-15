import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { isUniqueViolation, PrismaService } from '@platform/core/database'
import {
  type BenefitStateType,
  BenefitPeriodKind,
  CarrierConfirmKeys,
  CarrierGuideDefaults,
  CarrierResourceTypes,
  civilDateOf,
  evaluatePeriod,
  GuideMovementKind,
  type GuideMovementKindType,
  type GuidePolicyBody,
  type CursorPage,
  type RecordGuideAdjustmentBody,
  type RecordGuidePurchaseBody,
  type VoidGuidePurchaseBody
} from '@platform/core/domain'
import { resourceConflict, resourceNotFound } from '@platform/core/errors'
import {
  currentBenefit,
  type GuidePolicy,
  guideBalanceOf,
  readGuidePolicy,
  storeTimezone
} from '@platform/core/shipping'

import { encodeCursor } from '../customers/list-cursor'
import type { Actor } from '../tenancy'

import type { ListGuideMovementsQuery } from './carrier-guides.schemas'
import type {
  BenefitPeriodView,
  BenefitView,
  GuideBalanceView,
  GuideMovementView,
  GuidePolicyView
} from './carrier-guides.views'

const PERIODS_SHOWN = 50
const ORDER = [{ createdAt: 'desc' }, { id: 'desc' }] as const

// The balance of prepaid guides and the refund benefit of a carrier connection of the store of the request (TDD_17 §4.18). The
// permission of each route is checked by the controller; the store is the one TenantGuard resolved, and every read and write
// below names it, so a connection of another store is a 404 whatever its id. The ledger is written here only by a person (a
// purchase, an adjustment, the void of a purchase); the consumption and the refunds are written by the move of a shipment and
// by the daily close (libs/core/shipping/src/guide-balance.ts).
@Injectable()
export class CarrierGuidesApiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async balance(storeId: string, connectionId: string): Promise<GuideBalanceView> {
    await this.assertConnection(storeId, connectionId)
    const [summary, policy] = await Promise.all([
      guideBalanceOf(this.prisma.client, storeId, connectionId),
      readGuidePolicy(this.prisma.client, storeId, connectionId)
    ])
    const threshold = policy?.lowBalanceThreshold ?? null
    const tracked = policy?.balanceEnabled ?? false
    return {
      tracked,
      ...summary,
      lowBalanceThreshold: threshold,
      warnOnEmptyBalance: policy?.warnOnEmptyBalance ?? CarrierGuideDefaults.WARN_ON_EMPTY_BALANCE,
      // Only a connection that keeps its balance can be low or empty: with no policy the numbers are only what was recorded
      low: tracked && threshold !== null && summary.balance <= threshold,
      empty: tracked && summary.balance <= 0
    }
  }

  async movements(
    storeId: string,
    connectionId: string,
    query: ListGuideMovementsQuery
  ): Promise<CursorPage<GuideMovementView>> {
    await this.assertConnection(storeId, connectionId)
    const { cursor, limit } = query
    const rows = await this.prisma.client.carrierGuideMovement.findMany({
      where: {
        storeId,
        connectionId,
        ...(cursor === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } }
              ]
            })
      },
      include: { voidedBy: { select: { id: true } } },
      orderBy: [...ORDER],
      take: limit + 1
    })
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page.at(-1)
    return {
      data: page.map(row => this.viewOf(row, row.voidedBy !== null)),
      nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
      hasMore
    }
  }

  async recordPurchase(
    storeId: string,
    connectionId: string,
    body: RecordGuidePurchaseBody,
    actor: Actor
  ): Promise<GuideMovementView> {
    await this.assertConnection(storeId, connectionId)
    const row = await this.prisma.client.carrierGuideMovement.create({
      data: {
        storeId,
        connectionId,
        kind: GuideMovementKind.PURCHASE,
        guidesDelta: body.paidQuantity + body.giftQuantity,
        costCentsDelta: body.totalCostCents,
        paidQuantity: body.paidQuantity,
        giftQuantity: body.giftQuantity,
        note: body.note ?? null,
        createdBy: actor.userId
      }
    })
    this.record(AuditAction.CARRIER_GUIDE_PURCHASE_RECORDED, storeId, connectionId, actor, {
      movementId: row.id,
      paidQuantity: body.paidQuantity,
      giftQuantity: body.giftQuantity,
      totalCostCents: body.totalCostCents
    })
    return this.viewOf(row, false)
  }

  async adjust(
    storeId: string,
    connectionId: string,
    body: RecordGuideAdjustmentBody,
    actor: Actor
  ): Promise<GuideMovementView> {
    await this.assertConnection(storeId, connectionId)
    const row = await this.prisma.client.carrierGuideMovement.create({
      data: {
        storeId,
        connectionId,
        kind: GuideMovementKind.ADJUSTMENT,
        guidesDelta: body.guides,
        note: body.note,
        createdBy: actor.userId
      }
    })
    this.record(AuditAction.CARRIER_GUIDE_ADJUSTED, storeId, connectionId, actor, {
      movementId: row.id,
      guides: body.guides
    })
    return this.viewOf(row, false)
  }

  // Undoes a purchase typed by mistake with a movement that negates it (the ledger is never edited). A purchase is voided once.
  async voidPurchase(
    storeId: string,
    connectionId: string,
    movementId: string,
    body: VoidGuidePurchaseBody,
    actor: Actor
  ): Promise<GuideMovementView> {
    await this.assertConnection(storeId, connectionId)
    const purchase = await this.prisma.client.carrierGuideMovement.findFirst({
      where: { id: movementId, storeId, connectionId, kind: GuideMovementKind.PURCHASE },
      include: { voidedBy: { select: { id: true } } }
    })
    if (purchase === null) throw resourceNotFound('Purchase')
    if (purchase.voidedBy !== null) throw resourceConflict('The purchase was already voided')
    try {
      const row = await this.prisma.client.carrierGuideMovement.create({
        data: {
          storeId,
          connectionId,
          kind: GuideMovementKind.VOID,
          guidesDelta: -purchase.guidesDelta,
          costCentsDelta: -purchase.costCentsDelta,
          voidsMovementId: purchase.id,
          note: body.note,
          createdBy: actor.userId
        }
      })
      this.record(AuditAction.CARRIER_GUIDE_PURCHASE_VOIDED, storeId, connectionId, actor, {
        movementId: row.id,
        voidsMovementId: purchase.id
      })
      return this.viewOf(row, false)
    } catch (error) {
      // Two voids at once: the unique index of `voids_movement_id` says the second is late
      if (isUniqueViolation(error)) throw resourceConflict('The purchase was already voided')
      throw error
    }
  }

  async policy(storeId: string, connectionId: string): Promise<GuidePolicyView> {
    await this.assertConnection(storeId, connectionId)
    const stored = await readGuidePolicy(this.prisma.client, storeId, connectionId)
    if (stored !== null) return this.policyView(stored, true)
    // Nothing saved: what saving the defaults would store, with the anchor on today of the store
    const zone = await this.timezoneOf(storeId)
    const today = civilDateOf(new Date(), zone)
    const anchor = [today.year, today.month, today.day]
      .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, '0'))
      .join('-')
    return this.policyView(
      {
        connectionId,
        storeId,
        balanceEnabled: CarrierGuideDefaults.BALANCE_ENABLED,
        benefitEnabled: CarrierGuideDefaults.BENEFIT_ENABLED,
        warnOnEmptyBalance: CarrierGuideDefaults.WARN_ON_EMPTY_BALANCE,
        lowBalanceThreshold: CarrierGuideDefaults.LOW_BALANCE_THRESHOLD,
        periodKind: CarrierGuideDefaults.PERIOD_KIND,
        periodDays: CarrierGuideDefaults.PERIOD_DAYS,
        periodAnchor: anchor,
        thresholdBps: CarrierGuideDefaults.THRESHOLD_BPS,
        warnAtBps: CarrierGuideDefaults.WARN_AT_BPS,
        base: CarrierGuideDefaults.BASE,
        returnStatuses: [...CarrierGuideDefaults.RETURN_STATUSES],
        refundRule: CarrierGuideDefaults.REFUND_RULE,
        lossRule: CarrierGuideDefaults.LOSS_RULE,
        benefitSince: new Date()
      },
      false
    )
  }

  async setPolicy(
    storeId: string,
    connectionId: string,
    body: GuidePolicyBody,
    actor: Actor
  ): Promise<GuidePolicyView> {
    const before = await this.policy(storeId, connectionId)
    const data = {
      balanceEnabled: body.balanceEnabled,
      benefitEnabled: body.benefitEnabled,
      warnOnEmptyBalance: body.warnOnEmptyBalance,
      lowBalanceThreshold: body.lowBalanceThreshold,
      periodKind: body.periodKind,
      periodDays: body.periodDays,
      periodAnchor: body.periodAnchor,
      thresholdBps: body.thresholdBps,
      warnAtBps: body.warnAtBps,
      base: body.base,
      returnStatuses: body.returnStatuses,
      refundRule: body.refundRule,
      lossRule: body.lossRule
    }
    // The days and the anchor only shape a period of fixed days: changing them under a calendar period changes nothing
    const fixedDaysChanged =
      body.periodKind === BenefitPeriodKind.FIXED_DAYS &&
      (body.periodDays !== before.periodDays || body.periodAnchor !== before.periodAnchor)
    const benefitRestarts =
      body.benefitEnabled &&
      (!before.benefitEnabled || body.periodKind !== before.periodKind || fixedDaysChanged)
    await this.prisma.client.carrierGuidePolicy.upsert({
      where: { storeId_connectionId: { storeId, connectionId } },
      create: { storeId, connectionId, ...data },
      // The benefit is judged from when it is switched on or its periods change, never retroactively
      update: {
        ...data,
        ...(benefitRestarts ? { benefitSince: new Date() } : {})
      }
    })
    this.record(AuditAction.CARRIER_GUIDE_POLICY_CHANGED, storeId, connectionId, actor, {
      // Null the first time: nothing was stored, what `policy` shows is only the defaults
      before: before.stored ? this.auditable(before) : null,
      after: data
    })
    return this.policy(storeId, connectionId)
  }

  // The rate and the state of the period that holds now
  async benefit(storeId: string, connectionId: string): Promise<BenefitView> {
    await this.assertConnection(storeId, connectionId)
    const policy = await readGuidePolicy(this.prisma.client, storeId, connectionId)
    if (policy === null || !policy.benefitEnabled) {
      return {
        enabled: false,
        state: null,
        periodStart: null,
        periodEnd: null,
        baseCount: 0,
        returnCount: 0,
        rateBps: 0,
        thresholdBps: policy?.thresholdBps ?? null,
        warnAtBps: policy?.warnAtBps ?? null,
        crossedAt: null
      }
    }
    const { bounds, events } = await currentBenefit(this.prisma.client, policy, new Date())
    const result = evaluatePeriod(policy, events)
    return {
      enabled: true,
      state: result.state,
      periodStart: bounds.start.toISOString(),
      periodEnd: bounds.end.toISOString(),
      baseCount: result.baseCount,
      returnCount: result.returnCount,
      rateBps: result.rateBps,
      thresholdBps: policy.thresholdBps,
      warnAtBps: policy.warnAtBps,
      crossedAt: result.crossedAt?.toISOString() ?? null
    }
  }

  async benefitPeriods(storeId: string, connectionId: string): Promise<BenefitPeriodView[]> {
    await this.assertConnection(storeId, connectionId)
    const rows = await this.prisma.client.carrierBenefitPeriod.findMany({
      where: { storeId, connectionId },
      orderBy: { periodStart: 'desc' },
      take: PERIODS_SHOWN
    })
    return rows.map(row => ({
      periodStart: row.periodStart.toISOString(),
      periodEnd: row.periodEnd.toISOString(),
      baseCount: row.baseCount,
      returnCount: row.returnCount,
      rateBps: row.rateBps,
      state: row.state as BenefitStateType,
      refundedCount: row.refundedCount,
      closedAt: row.closedAt.toISOString()
    }))
  }

  private async assertConnection(storeId: string, connectionId: string): Promise<void> {
    const found = await this.prisma.client.carrierConnection.findFirst({
      where: { id: connectionId, storeId },
      select: { id: true }
    })
    if (found === null) throw resourceNotFound('Carrier connection')
  }

  private async timezoneOf(storeId: string): Promise<string> {
    return storeTimezone(this.prisma.client, storeId)
  }

  // The ledger only has to answer the periods it asks of the policy: this is what the screen shows for a policy
  private policyView(policy: GuidePolicy, stored: boolean): GuidePolicyView {
    return {
      stored,
      balanceEnabled: policy.balanceEnabled,
      benefitEnabled: policy.benefitEnabled,
      warnOnEmptyBalance: policy.warnOnEmptyBalance,
      lowBalanceThreshold: policy.lowBalanceThreshold,
      periodKind: policy.periodKind,
      periodDays: policy.periodDays,
      periodAnchor: policy.periodAnchor,
      thresholdBps: policy.thresholdBps,
      warnAtBps: policy.warnAtBps,
      base: policy.base,
      returnStatuses: policy.returnStatuses,
      refundRule: policy.refundRule,
      lossRule: policy.lossRule,
      toConfirm: CarrierConfirmKeys
    }
  }

  // The settings of a policy as the audit keeps them: what changed hands, never the screen's own flags
  private auditable(view: GuidePolicyView): Record<string, unknown> {
    return {
      balanceEnabled: view.balanceEnabled,
      benefitEnabled: view.benefitEnabled,
      warnOnEmptyBalance: view.warnOnEmptyBalance,
      lowBalanceThreshold: view.lowBalanceThreshold,
      periodKind: view.periodKind,
      periodDays: view.periodDays,
      periodAnchor: view.periodAnchor,
      thresholdBps: view.thresholdBps,
      warnAtBps: view.warnAtBps,
      base: view.base,
      returnStatuses: view.returnStatuses,
      refundRule: view.refundRule,
      lossRule: view.lossRule
    }
  }

  private viewOf(
    row: {
      id: string
      kind: string
      guidesDelta: number
      costCentsDelta: number
      paidQuantity: number | null
      giftQuantity: number | null
      unitCostCents: number | null
      shipmentId: string | null
      voidsMovementId: string | null
      note: string | null
      createdBy: string
      occurredAt: Date
      createdAt: Date
    },
    voided: boolean
  ): GuideMovementView {
    return {
      id: row.id,
      kind: row.kind as GuideMovementKindType,
      guidesDelta: row.guidesDelta,
      costCentsDelta: row.costCentsDelta,
      paidQuantity: row.paidQuantity,
      giftQuantity: row.giftQuantity,
      unitCostCents: row.unitCostCents,
      shipmentId: row.shipmentId,
      voidsMovementId: row.voidsMovementId,
      voided,
      note: row.note,
      createdBy: row.createdBy,
      occurredAt: row.occurredAt.toISOString(),
      createdAt: row.createdAt.toISOString()
    }
  }

  private record(
    action:
      | typeof AuditAction.CARRIER_GUIDE_PURCHASE_RECORDED
      | typeof AuditAction.CARRIER_GUIDE_PURCHASE_VOIDED
      | typeof AuditAction.CARRIER_GUIDE_ADJUSTED
      | typeof AuditAction.CARRIER_GUIDE_POLICY_CHANGED,
    storeId: string,
    connectionId: string,
    actor: Actor,
    metadata: Record<string, unknown>
  ): void {
    this.audit.log({
      action,
      actor: { userId: actor.userId },
      storeId,
      resourceType: CarrierResourceTypes.CARRIER_CONNECTION,
      resourceId: connectionId,
      metadata,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
  }
}
