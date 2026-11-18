import { AccountRole, FinancePostingFailureReason, PartyType } from '@platform/core/domain'

import {
  chargeAmounts,
  chargeLines,
  type DraftLine,
  guidePurchaseLines,
  remittanceLines,
  type RemittanceLineFacts,
  replaySettlements,
  type RoleAccounts,
  settleRemittanceLine
} from './index'

const accounts: RoleAccounts = role => `acc-${role}`
const STORE = 'store-1'
const CARRIER = 'conn-1'

const sum = (lines: readonly DraftLine[], side: 'debitCents' | 'creditCents'): number =>
  lines.reduce((total, line) => total + line[side], 0)
const lineOf = (lines: readonly DraftLine[], account: string): DraftLine | undefined =>
  lines.find(line => line.accountId === account)

describe('chargeAmounts (E4)', () => {
  it('charges the commission over the cash collected, half up, and the guide only when the sender pays', () => {
    // 450 bps of 25.15 = 1.131750 -> 1.13; the carrier reported a cost of 3.00
    expect(
      chargeAmounts({
        shippingPayer: 'sender',
        codAmountCents: 2515,
        carrierCostCents: 300,
        carrierRateCents: 250,
        commissionBps: 450
      })
    ).toEqual({ freightCents: 300, commissionCents: 113 })
  })

  it('falls back to the rate kept on the guide, and charges no guide to the recipient', () => {
    expect(
      chargeAmounts({
        shippingPayer: 'sender',
        codAmountCents: null,
        carrierCostCents: null,
        carrierRateCents: 250,
        commissionBps: 450
      })
    ).toEqual({ freightCents: 250, commissionCents: 0 })
    expect(
      chargeAmounts({
        shippingPayer: 'recipient',
        codAmountCents: 1000,
        carrierCostCents: 300,
        carrierRateCents: null,
        commissionBps: 500
      })
    ).toEqual({ freightCents: 0, commissionCents: 50 })
  })

  it('is zero when nothing is known: no cost, no commission', () => {
    expect(
      chargeAmounts({
        shippingPayer: 'sender',
        codAmountCents: 1000,
        carrierCostCents: null,
        carrierRateCents: null,
        commissionBps: null
      })
    ).toEqual({ freightCents: 0, commissionCents: 0 })
  })
})

describe('chargeAmounts of a guide paid out of the advance (E4, HC-101)', () => {
  const base = {
    shippingPayer: 'sender',
    codAmountCents: 2515,
    carrierCostCents: 300,
    carrierRateCents: 250,
    commissionBps: 450
  }

  it('takes the cost of the guide from the advance at what the advance cost, not from what the carrier reported', () => {
    expect(chargeAmounts({ ...base, prepaidGuideCostCents: 273 })).toEqual({
      freightCents: 273,
      advanceCents: 273,
      commissionCents: 113
    })
  })

  it('consumes the advance whoever pays the guide: the guide was bought and is gone either way', () => {
    expect(
      chargeAmounts({ ...base, shippingPayer: 'recipient', prepaidGuideCostCents: 273 })
    ).toEqual({ freightCents: 273, advanceCents: 273, commissionCents: 113 })
  })

  it('is the plain charge when no advance covered the guide (no purchase on record, a connection that is not prepaid)', () => {
    expect(chargeAmounts({ ...base, prepaidGuideCostCents: null })).toEqual({
      freightCents: 300,
      commissionCents: 113
    })
    expect(chargeAmounts(base)).toEqual({ freightCents: 300, commissionCents: 113 })
  })

  it('a free guide (a gift) takes nothing from the advance', () => {
    expect(chargeAmounts({ ...base, prepaidGuideCostCents: 0 })).toEqual({
      freightCents: 0,
      advanceCents: 0,
      commissionCents: 113
    })
  })
})

describe('chargeLines of a guide paid out of the advance (E4, HC-101)', () => {
  it('credits the advance for the guide and the payable only for the commission: no payable for a freight already paid', () => {
    const result = chargeLines({
      accounts,
      carrierConnectionId: CARRIER,
      amounts: { freightCents: 273, advanceCents: 273, commissionCents: 113 },
      storeId: STORE
    })
    if (!result.ok) throw new Error('expected lines')
    expect(sum(result.lines, 'debitCents')).toBe(386)
    expect(sum(result.lines, 'creditCents')).toBe(386)
    expect(lineOf(result.lines, `acc-${AccountRole.CARRIER_FREIGHT_EXPENSE}`)?.debitCents).toBe(273)
    expect(lineOf(result.lines, `acc-${AccountRole.PREPAID_CARRIER_GUIDES}`)?.creditCents).toBe(273)
    expect(lineOf(result.lines, `acc-${AccountRole.PAYABLE_CARRIERS}`)).toMatchObject({
      creditCents: 113,
      partyType: PartyType.CARRIER_CONNECTION,
      partyId: CARRIER
    })
  })

  it('a guide with no commission posts no payable line at all', () => {
    const result = chargeLines({
      accounts,
      carrierConnectionId: CARRIER,
      amounts: { freightCents: 273, advanceCents: 273, commissionCents: 0 },
      storeId: STORE
    })
    if (!result.ok) throw new Error('expected lines')
    expect(result.lines).toHaveLength(2)
    expect(lineOf(result.lines, `acc-${AccountRole.PAYABLE_CARRIERS}`)).toBeUndefined()
  })

  it('names the advance when it has no account: the entry fails visibly, it never falls back to the payable', () => {
    const result = chargeLines({
      accounts: role => (role === AccountRole.PREPAID_CARRIER_GUIDES ? null : `acc-${role}`),
      carrierConnectionId: CARRIER,
      amounts: { freightCents: 273, advanceCents: 273, commissionCents: 0 },
      storeId: STORE
    })
    expect(result).toEqual({
      ok: false,
      reason: FinancePostingFailureReason.ROLE_NOT_MAPPED,
      role: AccountRole.PREPAID_CARRIER_GUIDES
    })
  })
})

describe('chargeLines (E4)', () => {
  it('debits freight and commission and credits the payable with the carrier as the party', () => {
    const result = chargeLines({
      accounts,
      carrierConnectionId: CARRIER,
      amounts: { freightCents: 300, commissionCents: 113 },
      storeId: STORE
    })
    if (!result.ok) throw new Error('expected lines')
    expect(sum(result.lines, 'debitCents')).toBe(413)
    expect(sum(result.lines, 'creditCents')).toBe(413)
    expect(lineOf(result.lines, `acc-${AccountRole.CARRIER_FREIGHT_EXPENSE}`)?.debitCents).toBe(300)
    expect(lineOf(result.lines, `acc-${AccountRole.CARRIER_COMMISSION_EXPENSE}`)?.debitCents).toBe(
      113
    )
    expect(lineOf(result.lines, `acc-${AccountRole.PAYABLE_CARRIERS}`)).toMatchObject({
      creditCents: 413,
      partyType: PartyType.CARRIER_CONNECTION,
      partyId: CARRIER,
      storeId: STORE
    })
  })

  it('drops the line of a charge that is zero and posts nothing when both are', () => {
    const only = chargeLines({
      accounts,
      carrierConnectionId: CARRIER,
      amounts: { freightCents: 0, commissionCents: 113 },
      storeId: STORE
    })
    if (!only.ok) throw new Error('expected lines')
    expect(only.lines).toHaveLength(2)
    expect(
      chargeLines({
        accounts,
        carrierConnectionId: CARRIER,
        amounts: { freightCents: 0, commissionCents: 0 },
        storeId: STORE
      })
    ).toEqual({ ok: true, lines: [] })
  })

  it('names the role that has no account', () => {
    const result = chargeLines({
      accounts: role => (role === AccountRole.PAYABLE_CARRIERS ? null : `acc-${role}`),
      carrierConnectionId: CARRIER,
      amounts: { freightCents: 0, commissionCents: 113 },
      storeId: STORE
    })
    expect(result).toEqual({
      ok: false,
      reason: FinancePostingFailureReason.ROLE_NOT_MAPPED,
      role: AccountRole.PAYABLE_CARRIERS
    })
  })
})

const facts = (over: Partial<RemittanceLineFacts> = {}): RemittanceLineFacts => ({
  reportedCents: 2000,
  reportedFeeCents: null,
  estimateCents: 513,
  deductsFee: true,
  // 26.00 to collect: the figures below leave room for the fee of each case
  grossCents: 2600,
  clearedBeforeCents: 0,
  feeAlreadySettled: false,
  ...over
})

describe('settleRemittanceLine (E5)', () => {
  it('settles the estimate when the carrier deducts its fee and the file has no figure', () => {
    expect(settleRemittanceLine(facts())).toEqual({
      reportedCents: 2000,
      keptCents: 513,
      deductedCents: 513,
      owedCents: 0,
      payableCents: 513,
      expenseCents: 0,
      clearedCents: 2513
    })
  })

  it('lets the figure of the file win over the estimate: what it kept beyond it is commission expense', () => {
    // the carrier kept 5.40 and E4 estimated 5.13: 0.27 more of expense
    expect(settleRemittanceLine(facts({ reportedFeeCents: 540 }))).toEqual({
      reportedCents: 2000,
      keptCents: 540,
      deductedCents: 540,
      owedCents: 0,
      payableCents: 513,
      expenseCents: 27,
      clearedCents: 2540
    })
    // kept less than estimated: only what it kept is settled, the rest stays owed (to be invoiced), no expense is taken back
    expect(settleRemittanceLine(facts({ reportedFeeCents: 500 }))).toMatchObject({
      keptCents: 500,
      payableCents: 500,
      expenseCents: 0,
      clearedCents: 2500
    })
  })

  it('keeps the payable owed when the carrier does not deduct its fee', () => {
    expect(settleRemittanceLine(facts({ deductsFee: false }))).toEqual({
      reportedCents: 2000,
      keptCents: 0,
      deductedCents: 0,
      owedCents: 0,
      payableCents: 0,
      expenseCents: 0,
      clearedCents: 2000
    })
  })

  it('treats a fee of nothing in the file as nothing kept, and a fee with no estimate as pure expense', () => {
    expect(settleRemittanceLine(facts({ reportedFeeCents: 0 }))).toMatchObject({
      keptCents: 0,
      payableCents: 0
    })
    expect(settleRemittanceLine(facts({ estimateCents: 0, reportedFeeCents: 300 }))).toMatchObject({
      keptCents: 300,
      payableCents: 0,
      expenseCents: 300
    })
  })

  it('settles the payable once: a guide settled again takes only the figure of its file', () => {
    expect(settleRemittanceLine(facts({ feeAlreadySettled: true, reportedCents: 300 }))).toEqual({
      reportedCents: 300,
      keptCents: 0,
      deductedCents: 0,
      owedCents: 0,
      payableCents: 0,
      expenseCents: 0,
      clearedCents: 300
    })
    expect(
      settleRemittanceLine(facts({ feeAlreadySettled: true, reportedFeeCents: 40 }))
    ).toMatchObject({ keptCents: 40, payableCents: 0, expenseCents: 40 })
  })
})

describe('remittanceLines (E5)', () => {
  const settle = (over: Partial<RemittanceLineFacts> = {}) => settleRemittanceLine(facts(over))

  it('one matched guide: cash for what was reported, payable for the fee, receivable for the gross', () => {
    const result = remittanceLines({
      accounts,
      destinationAccountId: null,
      carrierConnectionId: CARRIER,
      storeId: STORE,
      lines: [settle()]
    })
    if (!result.ok) throw new Error('expected lines')
    expect(lineOf(result.lines, `acc-${AccountRole.BANK_DEFAULT}`)?.debitCents).toBe(2000)
    expect(lineOf(result.lines, `acc-${AccountRole.PAYABLE_CARRIERS}`)).toMatchObject({
      debitCents: 513,
      partyType: PartyType.CARRIER_CONNECTION,
      partyId: CARRIER
    })
    expect(lineOf(result.lines, `acc-${AccountRole.RECEIVABLE_CARRIERS}`)).toMatchObject({
      creditCents: 2513,
      partyId: CARRIER
    })
    expect(sum(result.lines, 'debitCents')).toBe(2513)
    expect(sum(result.lines, 'creditCents')).toBe(2513)
  })

  it('goes to the account the owner chose, not to the default', () => {
    const result = remittanceLines({
      accounts,
      destinationAccountId: 'acc-chosen',
      carrierConnectionId: CARRIER,
      storeId: STORE,
      lines: [settle()]
    })
    if (!result.ok) throw new Error('expected lines')
    expect(lineOf(result.lines, 'acc-chosen')?.debitCents).toBe(2000)
    expect(lineOf(result.lines, `acc-${AccountRole.BANK_DEFAULT}`)).toBeUndefined()
  })

  it('adds up several guides, one of them with a difference: the shortfall stays open on the receivable', () => {
    // guide A: expected 20.00 reported 20.00 fee 5.13. Guide B: expected 20.00, the carrier reported 18.00 with fee 5.13:
    // it clears 23.13 of the 25.13 it was owed, so 2.00 stays open on the receivable
    const result = remittanceLines({
      accounts,
      destinationAccountId: null,
      carrierConnectionId: CARRIER,
      storeId: STORE,
      lines: [settle(), settle({ reportedCents: 1800 })]
    })
    if (!result.ok) throw new Error('expected lines')
    expect(lineOf(result.lines, `acc-${AccountRole.BANK_DEFAULT}`)?.debitCents).toBe(3800)
    expect(lineOf(result.lines, `acc-${AccountRole.PAYABLE_CARRIERS}`)?.debitCents).toBe(1026)
    expect(lineOf(result.lines, `acc-${AccountRole.RECEIVABLE_CARRIERS}`)?.creditCents).toBe(4826)
    expect(sum(result.lines, 'debitCents')).toBe(sum(result.lines, 'creditCents'))
  })

  it('settles only what the carrier kept when the file says it kept less than the estimate', () => {
    const result = remittanceLines({
      accounts,
      destinationAccountId: null,
      carrierConnectionId: CARRIER,
      storeId: STORE,
      lines: [settle({ reportedFeeCents: 500 })]
    })
    if (!result.ok) throw new Error('expected lines')
    expect(lineOf(result.lines, `acc-${AccountRole.PAYABLE_CARRIERS}`)?.debitCents).toBe(500)
    expect(lineOf(result.lines, `acc-${AccountRole.CARRIER_COMMISSION_EXPENSE}`)).toBeUndefined()
    expect(sum(result.lines, 'debitCents')).toBe(sum(result.lines, 'creditCents'))
  })

  it('debits the commission expense when it kept more', () => {
    const result = remittanceLines({
      accounts,
      destinationAccountId: null,
      carrierConnectionId: CARRIER,
      storeId: STORE,
      lines: [settle({ reportedFeeCents: 540 })]
    })
    if (!result.ok) throw new Error('expected lines')
    expect(lineOf(result.lines, `acc-${AccountRole.CARRIER_COMMISSION_EXPENSE}`)).toMatchObject({
      debitCents: 27,
      creditCents: 0
    })
    expect(sum(result.lines, 'debitCents')).toBe(2540)
    expect(sum(result.lines, 'creditCents')).toBe(2540)
  })

  it('a carrier that deducts nothing: cash against receivable, no payable line', () => {
    const result = remittanceLines({
      accounts,
      destinationAccountId: null,
      carrierConnectionId: CARRIER,
      storeId: STORE,
      lines: [settle({ deductsFee: false })]
    })
    if (!result.ok) throw new Error('expected lines')
    expect(result.lines).toHaveLength(2)
    expect(sum(result.lines, 'debitCents')).toBe(2000)
  })

  it('does not ask for the destination when no cash came', () => {
    const result = remittanceLines({
      accounts: role => (role === AccountRole.BANK_DEFAULT ? null : `acc-${role}`),
      destinationAccountId: null,
      carrierConnectionId: CARRIER,
      storeId: STORE,
      lines: [settle({ reportedCents: 0, reportedFeeCents: 0 })]
    })
    expect(result).toEqual({ ok: true, lines: [] })
  })

  it('posts nothing for no lines, and names a missing default account', () => {
    expect(
      remittanceLines({
        accounts,
        destinationAccountId: null,
        carrierConnectionId: CARRIER,
        storeId: STORE,
        lines: []
      })
    ).toEqual({ ok: true, lines: [] })
    expect(
      remittanceLines({
        accounts: role => (role === AccountRole.BANK_DEFAULT ? null : `acc-${role}`),
        destinationAccountId: null,
        carrierConnectionId: CARRIER,
        storeId: STORE,
        lines: [settle()]
      })
    ).toEqual({
      ok: false,
      reason: FinancePostingFailureReason.ROLE_NOT_MAPPED,
      role: AccountRole.BANK_DEFAULT
    })
  })
})

// A fee the cash could not cover (HC-001, AUT-523/529/530/531). What a carrier takes out of the cash it collected is bounded by that cash:
// the receivable of a guide is never cleared for more than it reported plus what was left to take out, and the part of the charge the cash
// could not cover stays owed to the carrier (a credit on the payable), while all of the charge is still the expense the file says.
describe('a fee larger than the cash the carrier collected (E5)', () => {
  const settle = (over: Partial<RemittanceLineFacts> = {}) => settleRemittanceLine(facts(over))
  const entry = (lines: ReturnType<typeof settleRemittanceLine>[]) => {
    const result = remittanceLines({
      accounts,
      destinationAccountId: null,
      carrierConnectionId: CARRIER,
      storeId: STORE,
      lines
    })
    if (!result.ok) throw new Error('expected lines')
    return result.lines
  }
  const shape = (lines: readonly DraftLine[]): [string, number, number][] =>
    lines
      .map((line): [string, number, number] => [
        line.accountId.replace('acc-', ''),
        line.debitCents,
        line.creditCents
      ])
      .sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1])

  // 25.99 to collect, E4 estimated 4.54 (freight 3.50 and commission 1.04, the sender pays), the carrier reported nothing and says it kept 30.00
  it('keeps the receivable at what the carrier collected and owes it the rest of its fee', () => {
    const settlement = settle({
      grossCents: 2599,
      reportedCents: 0,
      reportedFeeCents: 3000,
      estimateCents: 454
    })
    expect(settlement).toEqual({
      reportedCents: 0,
      keptCents: 3000,
      deductedCents: 2599,
      owedCents: 401,
      payableCents: 454,
      expenseCents: 2546,
      clearedCents: 2599
    })
    const lines = entry([settlement])
    expect(shape(lines)).toEqual(
      shape([
        {
          accountId: `acc-${AccountRole.CARRIER_COMMISSION_EXPENSE}`,
          debitCents: 2546,
          creditCents: 0
        },
        { accountId: `acc-${AccountRole.PAYABLE_CARRIERS}`, debitCents: 53, creditCents: 0 },
        { accountId: `acc-${AccountRole.RECEIVABLE_CARRIERS}`, debitCents: 0, creditCents: 2599 }
      ])
    )
    expect(sum(lines, 'debitCents')).toBe(sum(lines, 'creditCents'))
    // E4 credited the payable 4.54 and this debits 0.53: 4.01 stays owed to the carrier, exactly the fee the cash could not cover
    expect(454 - 53).toBe(settlement.owedCents)
  })

  it('nets the payable into a credit when the part owed is more than the estimate settled', () => {
    // a cash on delivery of 2.00 and a guide of 3.50 the sender pays: the carrier keeps the 2.00 it collected, 1.50 stays owed
    const settlement = settle({
      grossCents: 200,
      reportedCents: 0,
      reportedFeeCents: null,
      estimateCents: 350
    })
    expect(settlement).toMatchObject({
      keptCents: 350,
      deductedCents: 200,
      owedCents: 150,
      payableCents: 350,
      expenseCents: 0,
      clearedCents: 200
    })
    const lines = entry([settlement])
    expect(shape(lines)).toEqual(
      shape([
        { accountId: `acc-${AccountRole.PAYABLE_CARRIERS}`, debitCents: 200, creditCents: 0 },
        { accountId: `acc-${AccountRole.RECEIVABLE_CARRIERS}`, debitCents: 0, creditCents: 200 }
      ])
    )
    // E4 credited 3.50, this debits 2.00: 1.50 stays owed, exactly the part the cash could not cover
    expect(350 - 200).toBe(settlement.owedCents)
  })

  it('credits the payable when the part owed is more than what it settles', () => {
    // E4 had nothing posted for the guide (estimate 0) and the file says the carrier kept 30.00 of a 25.99 collected
    const settlement = settle({
      grossCents: 2599,
      reportedCents: 0,
      reportedFeeCents: 3000,
      estimateCents: 0
    })
    expect(settlement).toMatchObject({
      keptCents: 3000,
      deductedCents: 2599,
      owedCents: 401,
      payableCents: 0,
      expenseCents: 3000,
      clearedCents: 2599
    })
    const lines = entry([settlement])
    expect(shape(lines)).toEqual(
      shape([
        {
          accountId: `acc-${AccountRole.CARRIER_COMMISSION_EXPENSE}`,
          debitCents: 3000,
          creditCents: 0
        },
        { accountId: `acc-${AccountRole.PAYABLE_CARRIERS}`, debitCents: 0, creditCents: 401 },
        { accountId: `acc-${AccountRole.RECEIVABLE_CARRIERS}`, debitCents: 0, creditCents: 2599 }
      ])
    )
  })

  it.each([
    // fee, expected deducted, expected owed
    ['the fee is the whole cash', 2599, 2599, 0],
    ['the fee is a cent over the cash', 2600, 2599, 1],
    ['the fee is a cent under the cash', 2598, 2598, 0]
  ])('%s', (_name, fee, deducted, owed) => {
    const settlement = settle({
      grossCents: 2599,
      reportedCents: 0,
      reportedFeeCents: fee,
      estimateCents: 454
    })
    expect(settlement).toMatchObject({
      keptCents: fee,
      deductedCents: deducted,
      owedCents: owed,
      clearedCents: deducted
    })
  })

  it('does not clear more than the cash when the carrier does not deduct its fee but lists it with the whole cash remitted', () => {
    // the file lists a fee of 1.04 and the carrier remitted the whole 25.99: nothing was taken out of the cash, the fee stays owed
    const settlement = settle({
      grossCents: 2599,
      reportedCents: 2599,
      reportedFeeCents: 104,
      estimateCents: 104,
      deductsFee: false
    })
    expect(settlement).toMatchObject({
      keptCents: 104,
      deductedCents: 0,
      owedCents: 104,
      payableCents: 104,
      expenseCents: 0,
      clearedCents: 2599
    })
    const lines = entry([settlement])
    // no line of the payable: the 1.04 E4 posted is still owed
    expect(shape(lines)).toEqual(
      shape([
        { accountId: `acc-${AccountRole.BANK_DEFAULT}`, debitCents: 2599, creditCents: 0 },
        { accountId: `acc-${AccountRole.RECEIVABLE_CARRIERS}`, debitCents: 0, creditCents: 2599 }
      ])
    )
  })

  it('leaves the surplus of a carrier that reported more than it collected to the write-off, as it was', () => {
    // reported 26.00 on a guide of 25.15: nothing was left to take out of the cash, the 0.85 over is what E7 writes off
    const settlement = settle({
      grossCents: 2515,
      reportedCents: 2600,
      reportedFeeCents: null,
      estimateCents: 413
    })
    expect(settlement).toMatchObject({ deductedCents: 0, owedCents: 413, clearedCents: 2600 })
  })

  it('bounds what is left to take out by what earlier remittances of the guide already cleared', () => {
    // a first remittance cleared 24.00 of 25.99; the second reports 0.50 and a fee of 1.00: only 1.49 was left, 0.50 of it reported
    const settlement = settle({
      grossCents: 2599,
      clearedBeforeCents: 2400,
      reportedCents: 50,
      reportedFeeCents: 100,
      estimateCents: 0,
      feeAlreadySettled: true
    })
    expect(settlement).toMatchObject({
      keptCents: 100,
      deductedCents: 100,
      owedCents: 0,
      clearedCents: 150
    })
    const over = settle({
      grossCents: 2599,
      clearedBeforeCents: 2400,
      reportedCents: 150,
      reportedFeeCents: 100,
      estimateCents: 0,
      feeAlreadySettled: true
    })
    // 2,599 − 2,400 − 150 = 49 left: only 0.49 of the 1.00 comes out of the cash
    expect(over).toMatchObject({ deductedCents: 49, owedCents: 51, clearedCents: 199 })
  })

  it('takes nothing out of the cash of a guide with no amount to collect: the whole charge is owed', () => {
    expect(settle({ grossCents: null, reportedFeeCents: 3000 })).toMatchObject({
      deductedCents: 0,
      owedCents: 3000
    })
  })

  it('never reads a negative reported amount as more room', () => {
    expect(settle({ grossCents: 2599, reportedCents: -500, reportedFeeCents: 3000 })).toMatchObject(
      {
        deductedCents: 2599,
        owedCents: 401
      }
    )
  })

  // The table: for every guide, with the sender or the recipient paying (the estimate of E4 is 4.54 or 1.04) and the carrier
  // deducting or not, the entry balances, the receivable is never cleared for more than the larger of what was collected and what
  // was reported, and the whole charge is the expense and the payable it is settled against.
  it.each(
    [2599, 200].flatMap(gross =>
      [0, 1, gross - 1, gross, gross + 1, 5000]
        .filter(reported => reported >= 0)
        .flatMap(reported =>
          [null, 0, gross - 1, gross, gross + 1, 3000]
            .filter(fee => fee === null || fee >= 0)
            .flatMap(fee =>
              [0, 104, 454].flatMap(estimate =>
                [true, false].map(deductsFee => ({ gross, reported, fee, estimate, deductsFee }))
              )
            )
        )
    )
  )(
    'keeps the receivable bounded and the entry balanced (gross $gross reported $reported fee $fee estimate $estimate deducts $deductsFee)',
    input => {
      const settlement = settle({
        grossCents: input.gross,
        reportedCents: input.reported,
        reportedFeeCents: input.fee,
        estimateCents: input.estimate,
        deductsFee: input.deductsFee
      })
      expect(settlement.deductedCents + settlement.owedCents).toBe(settlement.keptCents)
      expect(settlement.deductedCents).toBeGreaterThanOrEqual(0)
      expect(settlement.owedCents).toBeGreaterThanOrEqual(0)
      // never cleared above what was collected, unless the carrier itself reported more than that
      expect(settlement.clearedCents).toBeLessThanOrEqual(Math.max(input.gross, input.reported))
      const result = remittanceLines({
        accounts,
        destinationAccountId: null,
        carrierConnectionId: CARRIER,
        storeId: STORE,
        lines: [settlement]
      })
      if (!result.ok) throw new Error('expected lines')
      expect(sum(result.lines, 'debitCents')).toBe(sum(result.lines, 'creditCents'))
      // the receivable of a guide is credited exactly what the line clears
      expect(lineOf(result.lines, `acc-${AccountRole.RECEIVABLE_CARRIERS}`)?.creditCents ?? 0).toBe(
        settlement.clearedCents
      )
    }
  )
})

// What E5 and E7 both replay: the lines of one guide in the order their remittances were confirmed
describe('replaySettlements', () => {
  const guide = { estimateCents: 413, deductsFee: true, grossCents: 2515 }

  it('walks the remittances of a guide in order: each clears what the ones before it left', () => {
    // $24.00 reported leaves only $1.15 to keep a fee out of; the second one finds nothing left and settles no payable again
    const replay = replaySettlements(
      [
        { reportedCents: 2400, reportedFeeCents: null },
        { reportedCents: 0, reportedFeeCents: 50 }
      ],
      guide
    )
    expect(
      replay.settlements.map(line => [line.deductedCents, line.owedCents, line.clearedCents])
    ).toEqual([
      [115, 298, 2515],
      [0, 50, 0]
    ])
    expect(replay.clearedCents).toBe(2515)
    expect(replay.feeSettled).toBe(true)
  })

  it('says nothing was cleared or settled for a guide with no earlier remittance', () => {
    expect(replaySettlements([], guide)).toEqual({
      settlements: [],
      clearedCents: 0,
      feeSettled: false
    })
  })

  it('does not count a fee of nothing as the payable settled, so a later remittance may settle it', () => {
    const replay = replaySettlements([{ reportedCents: 1000, reportedFeeCents: 0 }], guide)
    expect(replay).toMatchObject({ clearedCents: 1000, feeSettled: false })
  })
})

describe('guidePurchaseLines (E15, E16)', () => {
  const base = { accounts, storeId: STORE, cents: 5000, paidFromAccountId: null }

  it('a purchase grows the advance and takes the money out of the default bank account', () => {
    const result = guidePurchaseLines({ ...base, reversal: false })
    if (!result.ok) throw new Error('expected lines')
    expect(lineOf(result.lines, `acc-${AccountRole.PREPAID_CARRIER_GUIDES}`)).toMatchObject({
      debitCents: 5000,
      creditCents: 0,
      storeId: STORE
    })
    expect(lineOf(result.lines, `acc-${AccountRole.BANK_DEFAULT}`)).toMatchObject({
      debitCents: 0,
      creditCents: 5000
    })
  })

  it('takes the money out of the account the person named, not the default', () => {
    const result = guidePurchaseLines({ ...base, paidFromAccountId: 'acc-cash', reversal: false })
    if (!result.ok) throw new Error('expected lines')
    expect(lineOf(result.lines, 'acc-cash')?.creditCents).toBe(5000)
    expect(lineOf(result.lines, `acc-${AccountRole.BANK_DEFAULT}`)).toBeUndefined()
  })

  it('the void is the same entry the other way round', () => {
    const result = guidePurchaseLines({ ...base, paidFromAccountId: 'acc-cash', reversal: true })
    if (!result.ok) throw new Error('expected lines')
    expect(lineOf(result.lines, `acc-${AccountRole.PREPAID_CARRIER_GUIDES}`)).toMatchObject({
      debitCents: 0,
      creditCents: 5000
    })
    expect(lineOf(result.lines, 'acc-cash')).toMatchObject({ debitCents: 5000, creditCents: 0 })
  })

  it('a purchase that cost nothing (all gifts) posts nothing', () => {
    expect(guidePurchaseLines({ ...base, cents: 0, reversal: false })).toEqual({
      ok: true,
      lines: []
    })
  })

  it('names the role that has no account: the advance first, then the default bank', () => {
    expect(
      guidePurchaseLines({
        ...base,
        accounts: role => (role === AccountRole.PREPAID_CARRIER_GUIDES ? null : `acc-${role}`),
        reversal: false
      })
    ).toMatchObject({ ok: false, role: AccountRole.PREPAID_CARRIER_GUIDES })
    expect(
      guidePurchaseLines({
        ...base,
        accounts: role => (role === AccountRole.BANK_DEFAULT ? null : `acc-${role}`),
        reversal: false
      })
    ).toMatchObject({ ok: false, role: AccountRole.BANK_DEFAULT })
  })
})
