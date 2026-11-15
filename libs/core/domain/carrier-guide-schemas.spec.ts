import { CarrierGuideDefaults } from './carrier-guide-constants'
import {
  guidePolicySchema,
  recordGuideAdjustmentSchema,
  recordGuidePurchaseSchema,
  voidGuidePurchaseSchema
} from './carrier-guide-schemas'

const POLICY = {
  balanceEnabled: true,
  benefitEnabled: true,
  warnOnEmptyBalance: true,
  lowBalanceThreshold: 10,
  periodKind: CarrierGuideDefaults.PERIOD_KIND,
  periodDays: CarrierGuideDefaults.PERIOD_DAYS,
  periodAnchor: '2026-11-01',
  thresholdBps: CarrierGuideDefaults.THRESHOLD_BPS,
  warnAtBps: CarrierGuideDefaults.WARN_AT_BPS,
  base: CarrierGuideDefaults.BASE,
  returnStatuses: [...CarrierGuideDefaults.RETURN_STATUSES],
  refundRule: CarrierGuideDefaults.REFUND_RULE,
  lossRule: CarrierGuideDefaults.LOSS_RULE
}

describe('recordGuidePurchaseSchema', () => {
  it('takes a package with a gift and a total in cents', () => {
    const parsed = recordGuidePurchaseSchema.parse({
      paidQuantity: 100,
      giftQuantity: 10,
      totalCostCents: 8000
    })
    expect(parsed).toEqual({ paidQuantity: 100, giftQuantity: 10, totalCostCents: 8000 })
  })
  it('defaults the gift to none and refuses fractions, negatives and an empty package', () => {
    expect(
      recordGuidePurchaseSchema.parse({ paidQuantity: 5, totalCostCents: 0 }).giftQuantity
    ).toBe(0)
    expect(
      recordGuidePurchaseSchema.safeParse({ paidQuantity: 1.5, totalCostCents: 1 }).success
    ).toBe(false)
    expect(
      recordGuidePurchaseSchema.safeParse({ paidQuantity: -1, totalCostCents: 1 }).success
    ).toBe(false)
    expect(
      recordGuidePurchaseSchema.safeParse({ paidQuantity: 0, totalCostCents: 1 }).success
    ).toBe(false)
    expect(
      recordGuidePurchaseSchema.safeParse({ paidQuantity: 1, totalCostCents: 1.5 }).success
    ).toBe(false)
  })
  it('refuses a store or a connection id in the body', () => {
    expect(
      recordGuidePurchaseSchema.safeParse({
        paidQuantity: 1,
        totalCostCents: 1,
        storeId: '11111111-1111-4111-8111-111111111111'
      }).success
    ).toBe(false)
  })
})

describe('recordGuideAdjustmentSchema and voidGuidePurchaseSchema', () => {
  it('needs a signed non-zero quantity and a reason', () => {
    expect(recordGuideAdjustmentSchema.safeParse({ guides: -3, note: 'lost box' }).success).toBe(
      true
    )
    expect(recordGuideAdjustmentSchema.safeParse({ guides: 0, note: 'x' }).success).toBe(false)
    expect(recordGuideAdjustmentSchema.safeParse({ guides: 3, note: '' }).success).toBe(false)
    expect(recordGuideAdjustmentSchema.safeParse({ guides: 3 }).success).toBe(false)
  })
  it('needs a reason to void', () => {
    expect(voidGuidePurchaseSchema.safeParse({ note: 'typed twice' }).success).toBe(true)
    expect(voidGuidePurchaseSchema.safeParse({}).success).toBe(false)
  })
})

describe('guidePolicySchema', () => {
  it('takes the defaults of this step', () => {
    expect(guidePolicySchema.safeParse(POLICY).success).toBe(true)
  })
  it('refuses an immediate refund with a loss from the close', () => {
    const result = guidePolicySchema.safeParse({
      ...POLICY,
      refundRule: 'immediate',
      lossRule: 'from_close'
    })
    expect(result.success).toBe(false)
  })
  it('refuses a threshold out of range, a bad anchor, a status that is not a return and no status', () => {
    expect(guidePolicySchema.safeParse({ ...POLICY, thresholdBps: 0 }).success).toBe(false)
    expect(guidePolicySchema.safeParse({ ...POLICY, thresholdBps: 10_001 }).success).toBe(false)
    expect(guidePolicySchema.safeParse({ ...POLICY, periodAnchor: '2026-13-01' }).success).toBe(
      false
    )
    expect(guidePolicySchema.safeParse({ ...POLICY, periodDays: 0 }).success).toBe(false)
    expect(guidePolicySchema.safeParse({ ...POLICY, returnStatuses: ['delivered'] }).success).toBe(
      false
    )
    expect(guidePolicySchema.safeParse({ ...POLICY, returnStatuses: [] }).success).toBe(false)
    expect(
      guidePolicySchema.safeParse({ ...POLICY, returnStatuses: ['returned', 'returned'] }).success
    ).toBe(false)
  })
  it('refuses a key it does not know', () => {
    expect(guidePolicySchema.safeParse({ ...POLICY, storeId: 'x' }).success).toBe(false)
  })
})
