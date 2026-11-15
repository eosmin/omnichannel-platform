import type {
  BenefitBaseType,
  BenefitLossRuleType,
  BenefitPeriodKindType,
  BenefitRefundRuleType,
  BenefitStateType,
  GuideMovementKindType,
  ShipmentStatus
} from '@platform/core/domain'

// The shapes the routes of the guide balance and the refund benefit answer (TDD_17 §4.18). Money is whole cents of USD and rates
// are basis points; dates are ISO instants.

export interface GuideBalanceView {
  // Is the balance kept for this connection (the policy's switch)? Off: the numbers below are only what was recorded by hand
  tracked: boolean
  balance: number
  receivedGuides: number
  paidCents: number
  averageCostCents: number | null
  lowBalanceThreshold: number | null
  warnOnEmptyBalance: boolean
  // The balance is at or under the low-balance threshold, and at or under zero
  low: boolean
  empty: boolean
}

export interface GuideMovementView {
  id: string
  kind: GuideMovementKindType
  guidesDelta: number
  costCentsDelta: number
  paidQuantity: number | null
  giftQuantity: number | null
  unitCostCents: number | null
  shipmentId: string | null
  voidsMovementId: string | null
  // A purchase that a later movement voided
  voided: boolean
  note: string | null
  createdBy: string
  occurredAt: string
  createdAt: string
}

export interface GuidePolicyView {
  // False: nothing was saved yet and this is what saving the defaults would store
  stored: boolean
  balanceEnabled: boolean
  benefitEnabled: boolean
  warnOnEmptyBalance: boolean
  lowBalanceThreshold: number | null
  periodKind: BenefitPeriodKindType
  periodDays: number
  periodAnchor: string
  thresholdBps: number
  warnAtBps: number
  base: BenefitBaseType
  returnStatuses: ShipmentStatus[]
  refundRule: BenefitRefundRuleType
  lossRule: BenefitLossRuleType
  // The settings whose value is a guess about a carrier's rule until the carrier confirms it (shown as such by the screen)
  toConfirm: readonly string[]
}

export interface BenefitView {
  enabled: boolean
  state: BenefitStateType | null
  periodStart: string | null
  periodEnd: string | null
  baseCount: number
  returnCount: number
  rateBps: number
  thresholdBps: number | null
  warnAtBps: number | null
  // When the rate reached the threshold in this period, if it did
  crossedAt: string | null
}

export interface BenefitPeriodView {
  periodStart: string
  periodEnd: string
  baseCount: number
  returnCount: number
  rateBps: number
  state: BenefitStateType
  refundedCount: number
  closedAt: string
}
