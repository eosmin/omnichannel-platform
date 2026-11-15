import { z } from 'zod'

import {
  BenefitBase,
  BenefitLossRule,
  BenefitPeriodKind,
  BenefitRefundRule,
  BenefitReturnStatuses,
  CarrierGuideLimits
} from './carrier-guide-constants'
import { parseCivilDate, policyProblem } from './carrier-guide-rules'
import { ShipmentStatus } from './status-enums'
import { singleLineText } from './validation'

// What a client sends to the guide balance and the benefit policy of a connection (TDD_17 §4.18). The body never carries a
// `storeId` or a `connectionId`: the store is the one TenantGuard resolved and the connection is the one of the route.

const guides = z.number().int().min(0).max(CarrierGuideLimits.MAX_GUIDES_PER_MOVEMENT)
const note = singleLineText(CarrierGuideLimits.NOTE_MAX_LENGTH)

// A purchase of guides: what was paid for, what came free, and the total paid (VAT included) in whole cents
export const recordGuidePurchaseSchema = z
  .strictObject({
    paidQuantity: guides,
    giftQuantity: guides.default(0),
    totalCostCents: z.number().int().min(0).max(CarrierGuideLimits.MAX_COST_CENTS),
    note: note.optional()
  })
  .refine(body => body.paidQuantity + body.giftQuantity >= 1, {
    message: 'a purchase has at least one guide',
    path: ['paidQuantity']
  })
export type RecordGuidePurchaseBody = z.output<typeof recordGuidePurchaseSchema>

// A correction nobody else can know: a signed, non-zero number of guides and why
export const recordGuideAdjustmentSchema = z.strictObject({
  guides: z
    .number()
    .int()
    .min(-CarrierGuideLimits.MAX_GUIDES_PER_MOVEMENT)
    .max(CarrierGuideLimits.MAX_GUIDES_PER_MOVEMENT)
    .refine(value => value !== 0, { message: 'an adjustment moves at least one guide' }),
  note: singleLineText(CarrierGuideLimits.NOTE_MAX_LENGTH, 1)
})
export type RecordGuideAdjustmentBody = z.output<typeof recordGuideAdjustmentSchema>

export const voidGuidePurchaseSchema = z.strictObject({
  note: singleLineText(CarrierGuideLimits.NOTE_MAX_LENGTH, 1)
})
export type VoidGuidePurchaseBody = z.output<typeof voidGuidePurchaseSchema>

// The policy of a connection, whole: a PUT replaces it and every key is required (a screen starts from what `GET` answers,
// which holds the defaults of `CarrierGuideDefaults` until something is saved)
export const guidePolicySchema = z
  .strictObject({
    balanceEnabled: z.boolean(),
    benefitEnabled: z.boolean(),
    warnOnEmptyBalance: z.boolean(),
    lowBalanceThreshold: z.number().int().min(1).max(CarrierGuideLimits.MAX_LOW_BALANCE).nullable(),
    periodKind: z.enum(BenefitPeriodKind),
    periodDays: z
      .number()
      .int()
      .min(CarrierGuideLimits.MIN_PERIOD_DAYS)
      .max(CarrierGuideLimits.MAX_PERIOD_DAYS),
    // A calendar day of the store, the first day of a period of fixed days
    periodAnchor: z.string().refine(value => parseCivilDate(value) !== null, {
      message: 'not a calendar date (YYYY-MM-DD)'
    }),
    thresholdBps: z.number().int().min(1).max(CarrierGuideLimits.MAX_THRESHOLD_BPS),
    warnAtBps: z.number().int().min(1).max(CarrierGuideLimits.MAX_THRESHOLD_BPS),
    base: z.enum(BenefitBase),
    returnStatuses: z
      .array(
        z.enum(ShipmentStatus).refine(status => BenefitReturnStatuses.includes(status), {
          message: 'not a return status'
        })
      )
      .min(1)
      .max(BenefitReturnStatuses.length)
      .refine(list => new Set(list).size === list.length, { message: 'a status twice' }),
    refundRule: z.enum(BenefitRefundRule),
    lossRule: z.enum(BenefitLossRule)
  })
  .superRefine((policy, ctx) => {
    const problem = policyProblem(policy)
    if (problem !== null) ctx.addIssue({ code: 'custom', message: problem, path: ['lossRule'] })
  })
export type GuidePolicyBody = z.output<typeof guidePolicySchema>
