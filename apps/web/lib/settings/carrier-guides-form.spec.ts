import {
  adjustmentBody,
  adjustmentProblems,
  bpsToPercent,
  EMPTY_ADJUSTMENT_DRAFT,
  EMPTY_PURCHASE_DRAFT,
  percentToBps,
  periodLastDay,
  policyBody,
  policyDraftOf,
  policyProblems,
  purchaseBody,
  purchaseProblems,
  usedGuides,
  voidBody,
  voidNoteProblem,
  type PolicyView
} from './carrier-guides-form'

const VIEW: PolicyView = {
  balanceEnabled: true,
  benefitEnabled: true,
  warnOnEmptyBalance: true,
  lowBalanceThreshold: null,
  periodKind: 'fixed_days',
  periodDays: 15,
  periodAnchor: '2026-11-01',
  thresholdBps: 1000,
  warnAtBps: 8000,
  base: 'delivered',
  returnStatuses: ['returned'],
  refundRule: 'at_period_close',
  lossRule: 'from_crossing'
}

describe('percentToBps and bpsToPercent', () => {
  it('reads a percent with at most two decimals, with a point or a comma', () => {
    expect(percentToBps('10')).toBe(1000)
    expect(percentToBps('7.5')).toBe(750)
    expect(percentToBps('12,25')).toBe(1225)
    expect(percentToBps('100')).toBe(10_000)
  })

  it('refuses a sign, a third decimal, text and more than 100 %', () => {
    for (const text of ['', '-1', '1.234', 'ten', '101', '1e2', '.5']) {
      expect(percentToBps(text)).toBeNull()
    }
  })

  it('writes the text a field starts with, and reads it back to the same number', () => {
    expect(bpsToPercent(1000)).toBe('10')
    expect(bpsToPercent(750)).toBe('7.5')
    expect(bpsToPercent(1225)).toBe('12.25')
    expect(bpsToPercent(5)).toBe('0.05')
    for (const bps of [1, 5, 750, 1000, 1225, 8000, 10_000]) {
      expect(percentToBps(bpsToPercent(bps))).toBe(bps)
    }
  })
})

describe('usedGuides', () => {
  it('is what was received less what is left', () => {
    expect(usedGuides({ receivedGuides: 110, balance: 40 })).toBe(70)
  })
})

describe('a purchase', () => {
  const ok = { paidQuantity: '100', giftQuantity: '10', totalCost: '45.50', note: ' bulk ' }

  it('turns into a body in whole cents, with the note trimmed', () => {
    expect(purchaseProblems(ok)).toEqual([])
    expect(purchaseBody(ok)).toEqual({
      paidQuantity: 100,
      giftQuantity: 10,
      totalCostCents: 4550,
      note: 'bulk'
    })
  })

  it('leaves the note out when it is empty', () => {
    expect(purchaseBody({ ...ok, note: '  ' })).not.toHaveProperty('note')
  })

  it('refuses an empty form, a fraction of a guide, a negative number and a bad amount', () => {
    expect(purchaseProblems(EMPTY_PURCHASE_DRAFT)).toEqual(expect.arrayContaining(['paid', 'cost']))
    expect(purchaseProblems({ ...ok, paidQuantity: '1.5' })).toContain('paid')
    expect(purchaseProblems({ ...ok, giftQuantity: '-1' })).toContain('gift')
    expect(purchaseProblems({ ...ok, totalCost: '4.555' })).toContain('cost')
    expect(purchaseProblems({ ...ok, totalCost: '2000000.00' })).toContain('cost')
  })

  it('refuses a purchase of no guide at all', () => {
    expect(purchaseProblems({ ...ok, paidQuantity: '0', giftQuantity: '0' })).toContain('none')
  })

  it('accepts a purchase of gift guides only, free of charge', () => {
    expect(
      purchaseProblems({ ...ok, paidQuantity: '0', giftQuantity: '5', totalCost: '0' })
    ).toEqual([])
  })
})

describe('an adjustment', () => {
  it('takes a signed whole number and a reason', () => {
    expect(adjustmentBody({ guides: '+5', note: ' lost ' })).toEqual({ guides: 5, note: 'lost' })
    expect(adjustmentBody({ guides: '-3', note: 'x' })).toEqual({ guides: -3, note: 'x' })
  })

  it('refuses 0, a fraction, text, and a missing reason', () => {
    expect(adjustmentProblems(EMPTY_ADJUSTMENT_DRAFT)).toEqual(['guides', 'note'])
    for (const guides of ['0', '1.5', 'abc', '-0']) {
      expect(adjustmentProblems({ guides, note: 'x' })).toEqual(['guides'])
    }
    expect(adjustmentProblems({ guides: '3', note: '   ' })).toEqual(['note'])
  })
})

describe('a void', () => {
  it('needs a reason', () => {
    expect(voidNoteProblem('')).toBe(true)
    expect(voidNoteProblem('  ')).toBe(true)
    expect(voidNoteProblem('typed twice')).toBe(false)
    expect(voidBody(' typed twice ')).toEqual({ note: 'typed twice' })
  })
})

describe('the policy', () => {
  it('goes from the view to a draft and back to the same body', () => {
    const draft = policyDraftOf(VIEW)
    expect(draft.threshold).toBe('10')
    expect(draft.warnAt).toBe('80')
    expect(policyProblems(draft)).toEqual([])
    expect(policyBody(draft)).toEqual({ ...VIEW, returnStatuses: ['returned'] })
  })

  it('keeps the statuses in the order of the catalog, with none twice', () => {
    const body = policyBody({
      ...policyDraftOf(VIEW),
      returnStatuses: ['returned', 'returning']
    })
    expect(body.returnStatuses).toEqual(['returning', 'returned'])
  })

  it('falls back to the default of a value it does not know', () => {
    const draft = policyDraftOf({
      ...VIEW,
      periodKind: 'weekly',
      base: 'x',
      refundRule: 'y',
      lossRule: 'z'
    })
    expect(draft.periodKind).toBe('fixed_days')
    expect(draft.base).toBe('delivered')
    expect(draft.refundRule).toBe('at_period_close')
    expect(draft.lossRule).toBe('from_crossing')
  })

  it('reads an empty low-balance number as none and refuses a bad one', () => {
    expect(policyBody(policyDraftOf(VIEW)).lowBalanceThreshold).toBeNull()
    const draft = policyDraftOf({ ...VIEW, lowBalanceThreshold: 20 })
    expect(policyBody(draft).lowBalanceThreshold).toBe(20)
    for (const text of ['0', '-1', '2.5', 'x']) {
      expect(policyProblems({ ...draft, lowBalanceThreshold: text })).toEqual(['lowBalance'])
    }
  })

  it('refuses a period of 0 or 367 days, a date that is not one, and a rate that is 0', () => {
    const draft = policyDraftOf(VIEW)
    expect(policyProblems({ ...draft, periodDays: '0' })).toEqual(['periodDays'])
    expect(policyProblems({ ...draft, periodDays: '367' })).toEqual(['periodDays'])
    expect(policyProblems({ ...draft, periodAnchor: '2026-02-30' })).toEqual(['anchor'])
    expect(policyProblems({ ...draft, threshold: '0' })).toEqual(['threshold'])
    expect(policyProblems({ ...draft, warnAt: '' })).toEqual(['warnAt'])
  })

  it('does not ask for the days or the anchor of a calendar period, which the form hides', () => {
    const draft = { ...policyDraftOf(VIEW), periodKind: 'calendar_month' as const }
    expect(policyProblems({ ...draft, periodDays: '', periodAnchor: '' })).toEqual([])
  })

  it('refuses no return status', () => {
    expect(policyProblems({ ...policyDraftOf(VIEW), returnStatuses: [] })).toEqual([
      'returnStatuses'
    ])
  })

  it('refuses an immediate refund that waits for the close to lose the benefit', () => {
    expect(
      policyProblems({
        ...policyDraftOf(VIEW),
        refundRule: 'immediate',
        lossRule: 'from_close'
      })
    ).toEqual(['combination'])
  })
})

describe('periodLastDay', () => {
  it('is the day before the end of the period, which is the start of the next', () => {
    expect(periodLastDay('2026-11-16T06:00:00.000Z').toISOString()).toBe('2026-11-16T05:59:59.999Z')
  })
})
