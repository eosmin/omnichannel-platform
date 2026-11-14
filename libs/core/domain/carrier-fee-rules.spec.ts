import {
  CarrierFeeLimits,
  commissionCents,
  feeSettingsProblem,
  formatBpsAsPercent,
  parsePercentToBps,
  rateCentsOf,
  remittanceDeductionCents
} from './carrier-fee-rules'

describe('commissionCents', () => {
  it('is the share of the amount, in whole cents, half up', () => {
    expect(commissionCents(10_000, 450)).toBe(450)
    expect(commissionCents(17_900, 450)).toBe(806) // 805.5 rounds up
    expect(commissionCents(17_900, 449)).toBe(804) // 803.7 rounds up to 804
    expect(commissionCents(1, 450)).toBe(0)
    expect(commissionCents(0, 450)).toBe(0)
    expect(commissionCents(10_000, 0)).toBe(0)
  })
  it('stays exact at the largest amounts', () => {
    expect(commissionCents(100_000_000, CarrierFeeLimits.MAX_COMMISSION_BPS)).toBe(50_000_000)
  })
})

describe('parsePercentToBps', () => {
  it('reads a percent with up to two decimals, with a point or a comma', () => {
    expect(parsePercentToBps('4.5')).toBe(450)
    expect(parsePercentToBps('4,5')).toBe(450)
    expect(parsePercentToBps(' 12.34 ')).toBe(1234)
    expect(parsePercentToBps('0')).toBe(0)
    expect(parsePercentToBps('4')).toBe(400)
    expect(parsePercentToBps('4.05')).toBe(405)
  })
  it('refuses what is not a plain percent', () => {
    for (const text of [
      '',
      ' ',
      '-1',
      '4.555',
      '4.',
      '.5',
      '1e2',
      '4%',
      'abc',
      '1,000.5',
      '4..5'
    ]) {
      expect(parsePercentToBps(text)).toBeNull()
    }
  })
})

describe('formatBpsAsPercent', () => {
  it('writes the percent without trailing zeros', () => {
    expect(formatBpsAsPercent(450)).toBe('4.5')
    expect(formatBpsAsPercent(400)).toBe('4')
    expect(formatBpsAsPercent(405)).toBe('4.05')
    expect(formatBpsAsPercent(0)).toBe('0')
    expect(formatBpsAsPercent(1234)).toBe('12.34')
  })
  it('round-trips with the parser', () => {
    for (let bps = 0; bps <= CarrierFeeLimits.MAX_COMMISSION_BPS; bps += 7) {
      expect(parsePercentToBps(formatBpsAsPercent(bps))).toBe(bps)
    }
  })
})

describe('remittanceDeductionCents', () => {
  it('is null when nothing is known to deduct', () => {
    expect(
      remittanceDeductionCents(10_000, {
        carrierCostCents: null,
        carrierRateCents: null,
        commissionBps: null
      })
    ).toBeNull()
  })
  it('keeps a commission of 0 as known: nothing deducted is not nothing known', () => {
    expect(
      remittanceDeductionCents(10_000, {
        carrierCostCents: null,
        carrierRateCents: null,
        commissionBps: 0
      })
    ).toBe(0)
  })
  it('adds the cost the carrier reported, or else the rate of the service, to the commission', () => {
    expect(
      remittanceDeductionCents(10_000, {
        carrierCostCents: 300,
        carrierRateCents: 999,
        commissionBps: 450
      })
    ).toBe(750)
    expect(
      remittanceDeductionCents(10_000, {
        carrierCostCents: null,
        carrierRateCents: 300,
        commissionBps: 450
      })
    ).toBe(750)
    expect(
      remittanceDeductionCents(10_000, {
        carrierCostCents: null,
        carrierRateCents: 300,
        commissionBps: null
      })
    ).toBe(300)
    expect(
      remittanceDeductionCents(10_000, {
        carrierCostCents: null,
        carrierRateCents: null,
        commissionBps: 450
      })
    ).toBe(450)
  })
})

describe('feeSettingsProblem', () => {
  const declared = { commission: true, rateServices: [{ code: 'CCE' }, { code: 'SEC' }] }
  it('accepts a percent in range and the rates of declared services', () => {
    expect(
      feeSettingsProblem(declared, { commissionBps: 450, serviceRatesCents: { CCE: 300 } })
    ).toBeNull()
    expect(
      feeSettingsProblem(declared, { commissionBps: null, serviceRatesCents: null })
    ).toBeNull()
    expect(feeSettingsProblem(declared, {})).toBeNull()
  })
  it('refuses a percent above the limit', () => {
    expect(
      feeSettingsProblem(declared, { commissionBps: CarrierFeeLimits.MAX_COMMISSION_BPS + 1 })
    ).not.toBeNull()
  })
  it('refuses a commission when the carrier declares none', () => {
    expect(
      feeSettingsProblem({ commission: false, rateServices: [] }, { commissionBps: 100 })
    ).not.toBeNull()
    expect(
      feeSettingsProblem({ commission: false, rateServices: [] }, { commissionBps: null })
    ).toBeNull()
    // Zero is no commission: a form that sends its default is not refused
    expect(
      feeSettingsProblem({ commission: false, rateServices: [] }, { commissionBps: 0 })
    ).toBeNull()
  })
  it('refuses a rate for a service the carrier did not declare, or a rate out of range', () => {
    expect(feeSettingsProblem(declared, { serviceRatesCents: { XXX: 100 } })).not.toBeNull()
    expect(feeSettingsProblem(declared, { serviceRatesCents: { CCE: -1 } })).not.toBeNull()
    expect(
      feeSettingsProblem(declared, {
        serviceRatesCents: { CCE: CarrierFeeLimits.MAX_RATE_CENTS + 1 }
      })
    ).not.toBeNull()
    expect(feeSettingsProblem(declared, { serviceRatesCents: { CCE: 1.5 } })).not.toBeNull()
  })
  it('refuses a rate table for a carrier that declares no services', () => {
    expect(
      feeSettingsProblem(
        { commission: true, rateServices: [] },
        { serviceRatesCents: { CCE: 100 } }
      )
    ).not.toBeNull()
  })
})

describe('rateCentsOf', () => {
  it('reads the rate of a service from the table', () => {
    expect(rateCentsOf({ CCE: 300, SEC: 0 }, 'CCE')).toBe(300)
    expect(rateCentsOf({ CCE: 300, SEC: 0 }, 'SEC')).toBe(0)
  })
  it('has none for a missing service, a missing table or a value that is not whole cents in range', () => {
    expect(rateCentsOf({ CCE: 300 }, 'SER')).toBeNull()
    expect(rateCentsOf({ CCE: 300 }, null)).toBeNull()
    expect(rateCentsOf(null, 'CCE')).toBeNull()
    expect(rateCentsOf([300], '0')).toBeNull()
    expect(rateCentsOf({ CCE: '300' }, 'CCE')).toBeNull()
    expect(rateCentsOf({ CCE: -1 }, 'CCE')).toBeNull()
    expect(rateCentsOf({ CCE: 1.5 }, 'CCE')).toBeNull()
    expect(rateCentsOf({ CCE: CarrierFeeLimits.MAX_RATE_CENTS + 1 }, 'CCE')).toBeNull()
  })
  it('never reads the prototype', () => {
    expect(rateCentsOf({}, 'toString')).toBeNull()
    expect(rateCentsOf({}, '__proto__')).toBeNull()
  })
})
