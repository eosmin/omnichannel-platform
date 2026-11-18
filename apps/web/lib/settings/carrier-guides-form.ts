import {
  BenefitBase,
  BenefitLossRule,
  BenefitPeriodKind,
  BenefitRefundRule,
  BenefitReturnStatuses,
  type BenefitBaseType,
  type BenefitLossRuleType,
  type BenefitPeriodKindType,
  type BenefitRefundRuleType,
  CarrierGuideLimits,
  type GuidePolicyBody,
  type RecordGuideAdjustmentBody,
  type RecordGuidePurchaseBody,
  parseCivilDate,
  policyProblem,
  type VoidGuidePurchaseBody
} from '@platform/core/domain'

import { parseCents } from '../products/money'

// The forms of the guide balance and of the refund benefit as plain values, and the checks done before the request
// (TDD_17 §4.18). The api checks the same and decides. Money is whole cents of USD and rates are basis points (a percent
// with at most two decimals); nothing goes through a float.

const BPS_PER_PERCENT = 100

// "10" -> 1000, "7.5" -> 750, "12,25" -> 1225; null for anything else (a sign, a third decimal, text, over 100 %)
export function percentToBps(text: string): number | null {
  const match = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(text.trim())
  if (match === null) return null
  const bps = Number(match[1]) * BPS_PER_PERCENT + Number((match[2] ?? '').padEnd(2, '0'))
  return bps <= CarrierGuideLimits.MAX_THRESHOLD_BPS ? bps : null
}

// 1000 -> "10", 750 -> "7.5", 1225 -> "12.25": the text a percent field starts with (a point whatever the language; the field
// takes either separator back)
export function bpsToPercent(bps: number): string {
  const whole = Math.trunc(bps / BPS_PER_PERCENT)
  const rest = bps % BPS_PER_PERCENT
  if (rest === 0) return String(whole)
  return `${whole}.${String(rest).padStart(2, '0').replace(/0$/, '')}`
}

// Digits only ('1e2', '7.5' and '-1' are not quantities); null when it is not
function wholeNumberOf(text: string): number | null {
  const trimmed = text.trim()
  return /^\d{1,9}$/.test(trimmed) ? Number(trimmed) : null
}

// The guides that are no longer in the balance: what was received less what is left. A refund and an adjustment move the
// balance too, so this is the net of the guides used, refunds and adjustments (the screen says so).
export function usedGuides(view: { receivedGuides: number; balance: number }): number {
  return view.receivedGuides - view.balance
}

// ----- a purchase -----

export const PurchaseProblems = {
  PAID: 'paid',
  GIFT: 'gift',
  NONE: 'none',
  COST: 'cost',
  NOTE: 'note'
} as const
export type PurchaseProblem = (typeof PurchaseProblems)[keyof typeof PurchaseProblems]

export interface PurchaseDraft {
  paidQuantity: string
  giftQuantity: string
  // Dollars as typed
  totalCost: string
  // The account the money left (empty: the default bank account of the books)
  paidFromAccountId: string
  note: string
}

export const EMPTY_PURCHASE_DRAFT: PurchaseDraft = {
  paidQuantity: '',
  giftQuantity: '0',
  totalCost: '',
  paidFromAccountId: '',
  note: ''
}

export function purchaseProblems(draft: PurchaseDraft): PurchaseProblem[] {
  const problems: PurchaseProblem[] = []
  const paid = wholeNumberOf(draft.paidQuantity)
  const gift = wholeNumberOf(draft.giftQuantity)
  const cost = parseCents(draft.totalCost)
  if (paid === null || paid > CarrierGuideLimits.MAX_GUIDES_PER_MOVEMENT) {
    problems.push(PurchaseProblems.PAID)
  }
  if (gift === null || gift > CarrierGuideLimits.MAX_GUIDES_PER_MOVEMENT) {
    problems.push(PurchaseProblems.GIFT)
  }
  if (paid !== null && gift !== null && paid + gift < 1) problems.push(PurchaseProblems.NONE)
  if (cost === null || cost > CarrierGuideLimits.MAX_COST_CENTS)
    problems.push(PurchaseProblems.COST)
  if (draft.note.trim().length > CarrierGuideLimits.NOTE_MAX_LENGTH) {
    problems.push(PurchaseProblems.NOTE)
  }
  return problems
}

// Only call with no problems
export function purchaseBody(draft: PurchaseDraft): RecordGuidePurchaseBody {
  const note = draft.note.trim()
  return {
    paidQuantity: Number(draft.paidQuantity.trim()),
    giftQuantity: Number(draft.giftQuantity.trim()),
    totalCostCents: parseCents(draft.totalCost) ?? 0,
    ...(draft.paidFromAccountId === '' ? {} : { paidFromAccountId: draft.paidFromAccountId }),
    ...(note === '' ? {} : { note })
  }
}

// ----- an adjustment and a void -----

export const AdjustmentProblems = { GUIDES: 'guides', NOTE: 'note' } as const
export type AdjustmentProblem = (typeof AdjustmentProblems)[keyof typeof AdjustmentProblems]

export interface AdjustmentDraft {
  // A signed whole number as typed
  guides: string
  note: string
}

export const EMPTY_ADJUSTMENT_DRAFT: AdjustmentDraft = { guides: '', note: '' }

function signedGuidesOf(text: string): number | null {
  const match = /^([+-]?)(\d{1,9})$/.exec(text.trim())
  if (match === null) return null
  const value = Number(match[2]) * (match[1] === '-' ? -1 : 1)
  return value !== 0 && Math.abs(value) <= CarrierGuideLimits.MAX_GUIDES_PER_MOVEMENT ? value : null
}

function noteProblem(note: string): boolean {
  const trimmed = note.trim()
  return trimmed.length < 1 || trimmed.length > CarrierGuideLimits.NOTE_MAX_LENGTH
}

export function adjustmentProblems(draft: AdjustmentDraft): AdjustmentProblem[] {
  const problems: AdjustmentProblem[] = []
  if (signedGuidesOf(draft.guides) === null) problems.push(AdjustmentProblems.GUIDES)
  if (noteProblem(draft.note)) problems.push(AdjustmentProblems.NOTE)
  return problems
}

export function adjustmentBody(draft: AdjustmentDraft): RecordGuideAdjustmentBody {
  return { guides: signedGuidesOf(draft.guides) ?? 0, note: draft.note.trim() }
}

export function voidNoteProblem(note: string): boolean {
  return noteProblem(note)
}

export function voidBody(note: string): VoidGuidePurchaseBody {
  return { note: note.trim() }
}

// ----- the policy -----

export const PolicyProblems = {
  LOW_BALANCE: 'lowBalance',
  PERIOD_DAYS: 'periodDays',
  ANCHOR: 'anchor',
  THRESHOLD: 'threshold',
  WARN_AT: 'warnAt',
  RETURN_STATUSES: 'returnStatuses',
  COMBINATION: 'combination'
} as const
export type PolicyProblem = (typeof PolicyProblems)[keyof typeof PolicyProblems]

export interface PolicyDraft {
  balanceEnabled: boolean
  benefitEnabled: boolean
  warnOnEmptyBalance: boolean
  // Digits as typed; empty is "no low-balance alert"
  lowBalanceThreshold: string
  periodKind: BenefitPeriodKindType
  periodDays: string
  // YYYY-MM-DD
  periodAnchor: string
  // Percents as typed
  threshold: string
  warnAt: string
  base: BenefitBaseType
  returnStatuses: string[]
  refundRule: BenefitRefundRuleType
  lossRule: BenefitLossRuleType
}

// What `GET` of the policy answers; the strings are the ones the api validated, so they are narrowed by value
export interface PolicyView {
  balanceEnabled: boolean
  benefitEnabled: boolean
  warnOnEmptyBalance: boolean
  lowBalanceThreshold: number | null
  periodKind: string
  periodDays: number
  periodAnchor: string
  thresholdBps: number
  warnAtBps: number
  base: string
  returnStatuses: string[]
  refundRule: string
  lossRule: string
}

function oneOf<T extends string>(values: Record<string, T>, value: string, fallback: T): T {
  const list: readonly string[] = Object.values(values)
  return list.includes(value) ? (value as T) : fallback
}

export function policyDraftOf(view: PolicyView): PolicyDraft {
  return {
    balanceEnabled: view.balanceEnabled,
    benefitEnabled: view.benefitEnabled,
    warnOnEmptyBalance: view.warnOnEmptyBalance,
    lowBalanceThreshold: view.lowBalanceThreshold === null ? '' : String(view.lowBalanceThreshold),
    periodKind: oneOf(BenefitPeriodKind, view.periodKind, BenefitPeriodKind.FIXED_DAYS),
    periodDays: String(view.periodDays),
    periodAnchor: view.periodAnchor,
    threshold: bpsToPercent(view.thresholdBps),
    warnAt: bpsToPercent(view.warnAtBps),
    base: oneOf(BenefitBase, view.base, BenefitBase.DELIVERED),
    returnStatuses: [...view.returnStatuses],
    refundRule: oneOf(BenefitRefundRule, view.refundRule, BenefitRefundRule.AT_PERIOD_CLOSE),
    lossRule: oneOf(BenefitLossRule, view.lossRule, BenefitLossRule.FROM_CROSSING)
  }
}

function lowBalanceOf(text: string): number | null | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const value = wholeNumberOf(trimmed)
  return value !== null && value >= 1 && value <= CarrierGuideLimits.MAX_LOW_BALANCE
    ? value
    : undefined
}

function positiveBpsOf(text: string): number | null {
  const bps = percentToBps(text)
  return bps !== null && bps >= 1 ? bps : null
}

export function policyProblems(draft: PolicyDraft): PolicyProblem[] {
  const problems: PolicyProblem[] = []
  if (lowBalanceOf(draft.lowBalanceThreshold) === undefined)
    problems.push(PolicyProblems.LOW_BALANCE)
  // The days and the anchor only count for a period of fixed days; the form hides them for a calendar one
  if (draft.periodKind === BenefitPeriodKind.FIXED_DAYS) {
    const days = wholeNumberOf(draft.periodDays)
    if (
      days === null ||
      days < CarrierGuideLimits.MIN_PERIOD_DAYS ||
      days > CarrierGuideLimits.MAX_PERIOD_DAYS
    ) {
      problems.push(PolicyProblems.PERIOD_DAYS)
    }
    if (parseCivilDate(draft.periodAnchor) === null) problems.push(PolicyProblems.ANCHOR)
  }
  if (positiveBpsOf(draft.threshold) === null) problems.push(PolicyProblems.THRESHOLD)
  if (positiveBpsOf(draft.warnAt) === null) problems.push(PolicyProblems.WARN_AT)
  if (draft.returnStatuses.length === 0) problems.push(PolicyProblems.RETURN_STATUSES)
  if (policyProblem(draft) !== null) problems.push(PolicyProblems.COMBINATION)
  return problems
}

// Only call with no problems
export function policyBody(draft: PolicyDraft): GuidePolicyBody {
  const statuses = BenefitReturnStatuses.filter(status => draft.returnStatuses.includes(status))
  return {
    balanceEnabled: draft.balanceEnabled,
    benefitEnabled: draft.benefitEnabled,
    warnOnEmptyBalance: draft.warnOnEmptyBalance,
    lowBalanceThreshold: lowBalanceOf(draft.lowBalanceThreshold) ?? null,
    periodKind: draft.periodKind,
    periodDays: Number(draft.periodDays.trim()),
    periodAnchor: draft.periodAnchor,
    thresholdBps: positiveBpsOf(draft.threshold) ?? 0,
    warnAtBps: positiveBpsOf(draft.warnAt) ?? 0,
    base: draft.base,
    returnStatuses: statuses,
    refundRule: draft.refundRule,
    lossRule: draft.lossRule
  }
}

// A period is [start, end): the end is the first instant of the next one. The last day it covers is the day before it.
export function periodLastDay(end: string): Date {
  return new Date(new Date(end).getTime() - 1)
}
