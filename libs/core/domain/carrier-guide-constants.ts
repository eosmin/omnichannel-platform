import { ShipmentStatus } from './status-enums'

// Prepaid guide balance and the refund benefit of a carrier connection (TDD_17 §4.18, Step 4.16). What the carriers do is the
// owner's report and is still to be confirmed with each of them, so every rule below is a setting of the connection and every
// default that stands for a carrier's rule is marked [CARRIER-CONFIRM]: when a carrier answers, the default changes here and
// the mark goes. No carrier is named in this file (rule 13).

// What a line of the ledger of guides is (it only ever grows: a trigger refuses an update or a delete)
export const GuideMovementKind = {
  PURCHASE: 'purchase',
  CONSUME: 'consume',
  REFUND: 'refund',
  ADJUSTMENT: 'adjustment',
  VOID: 'void'
} as const
export type GuideMovementKindType = (typeof GuideMovementKind)[keyof typeof GuideMovementKind]

// How a carrier connection charges the business for its guides (TDD_18 §4.2, note on E4; Step 4B.6b-4). It is a setting of the connection,
// read by the books: the same guide posts a different entry under each. A new connection is `invoiced`, which is how E4 was written.
export const CarrierChargeModel = {
  // The carrier bills the business later: a payable (E4 as written)
  INVOICED: 'invoiced',
  // The carrier deducts its charge from the money it remits (E5 settles the payable E4 posted)
  REMITTANCE: 'remittance',
  // The business bought guides in advance: the money was paid when they were bought (an advance, an asset) and each guide consumes
  // part of it, so the guide's cost is never owed again
  PREPAID: 'prepaid'
} as const
export type CarrierChargeModelType = (typeof CarrierChargeModel)[keyof typeof CarrierChargeModel]

// What the percentage of returns is taken over
export const BenefitBase = {
  CREATED: 'created',
  DISPATCHED: 'dispatched',
  DELIVERED: 'delivered'
} as const
export type BenefitBaseType = (typeof BenefitBase)[keyof typeof BenefitBase]

export const BenefitPeriodKind = {
  FIXED_DAYS: 'fixed_days',
  CALENDAR_MONTH: 'calendar_month',
  CALENDAR_HALF_MONTH: 'calendar_half_month'
} as const
export type BenefitPeriodKindType = (typeof BenefitPeriodKind)[keyof typeof BenefitPeriodKind]

export const BenefitRefundRule = {
  IMMEDIATE: 'immediate',
  AT_PERIOD_CLOSE: 'at_period_close'
} as const
export type BenefitRefundRuleType = (typeof BenefitRefundRule)[keyof typeof BenefitRefundRule]

export const BenefitLossRule = {
  FROM_CROSSING: 'from_crossing',
  FROM_CLOSE: 'from_close'
} as const
export type BenefitLossRuleType = (typeof BenefitLossRule)[keyof typeof BenefitLossRule]

export const BenefitState = {
  IN_FORCE: 'in_force',
  AT_RISK: 'at_risk',
  LOST: 'lost'
} as const
export type BenefitStateType = (typeof BenefitState)[keyof typeof BenefitState]

// The two levels of the balance alert and of the benefit alert (the `level` of their events)
export const GuideBalanceAlertLevel = { LOW: 'low', EMPTY: 'empty' } as const
export type GuideBalanceAlertLevelType =
  (typeof GuideBalanceAlertLevel)[keyof typeof GuideBalanceAlertLevel]

export const BenefitAlertLevel = { AT_RISK: 'at_risk', LOST: 'lost' } as const
export type BenefitAlertLevelType = (typeof BenefitAlertLevel)[keyof typeof BenefitAlertLevel]

// The statuses a policy may name as a return: what a carrier can say about a package that goes back to the sender
export const BenefitReturnStatuses: readonly ShipmentStatus[] = [
  ShipmentStatus.RETURNING,
  ShipmentStatus.RETURNED
]

// The statuses from which a package counts as dispatched (the base `dispatched`): every one after the pickup of the carrier
export const BenefitDispatchedStatuses: readonly ShipmentStatus[] = [
  ShipmentStatus.PICKED_UP,
  ShipmentStatus.IN_TRANSIT,
  ShipmentStatus.OUT_FOR_DELIVERY,
  ShipmentStatus.FAILED_ATTEMPT,
  ShipmentStatus.DELIVERED,
  ShipmentStatus.RETURNING,
  ShipmentStatus.RETURNED
]

// Who wrote a movement nobody typed (the move of a shipment, the daily close), and the zone used when a store names none the calendar
// can read
export const GuideMovementActor = { SYSTEM: 'system' } as const
export const GuideZoneFallback = 'UTC'

export const CarrierGuideLimits = {
  // One purchase and one adjustment are bounded so a typo cannot write an absurd balance
  MAX_GUIDES_PER_MOVEMENT: 1_000_000,
  MAX_COST_CENTS: 100_000_000,
  NOTE_MAX_LENGTH: 200,
  MAX_PERIOD_DAYS: 366,
  MIN_PERIOD_DAYS: 1,
  MAX_THRESHOLD_BPS: 10_000,
  MAX_LOW_BALANCE: 1_000_000,
  PAGE_SIZE_DEFAULT: 50,
  PAGE_SIZE_MAX: 200,
  // The daily close processes the periods that ended since the last one closed, at most this many per run and connection
  MAX_PERIODS_PER_CLOSE: 12
} as const

// The defaults of a new policy. Each marked one is a guess about a carrier's rule, never a fact.
export const CarrierGuideDefaults = {
  BALANCE_ENABLED: false,
  BENEFIT_ENABLED: false,
  WARN_ON_EMPTY_BALANCE: true,
  LOW_BALANCE_THRESHOLD: null,
  PERIOD_KIND: BenefitPeriodKind.FIXED_DAYS, // [CARRIER-CONFIRM]
  PERIOD_DAYS: 15, // [CARRIER-CONFIRM]
  THRESHOLD_BPS: 1000, // 10 % [CARRIER-CONFIRM]
  WARN_AT_BPS: 8000, // warn at 80 % of the limit
  BASE: BenefitBase.DELIVERED, // [CARRIER-CONFIRM]
  RETURN_STATUSES: [ShipmentStatus.RETURNED] as readonly ShipmentStatus[], // [CARRIER-CONFIRM]
  REFUND_RULE: BenefitRefundRule.AT_PERIOD_CLOSE, // [CARRIER-CONFIRM]
  LOSS_RULE: BenefitLossRule.FROM_CROSSING // [CARRIER-CONFIRM]
} as const

// The keys of the default that are a guess about a carrier, so a screen can mark them until the carrier answers
export const CarrierConfirmKeys = [
  'periodKind',
  'periodDays',
  'thresholdBps',
  'base',
  'returnStatuses',
  'refundRule',
  'lossRule'
] as const
