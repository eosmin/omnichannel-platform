import { AccountRole, FinancePostingFailureReason, PartyType } from '@platform/core/domain'

import {
  chargeAmounts,
  chargeLines,
  type DraftLine,
  remittanceLines,
  type RemittanceLineFacts,
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
  feeAlreadySettled: false,
  ...over
})

describe('settleRemittanceLine (E5)', () => {
  it('settles the estimate when the carrier deducts its fee and the file has no figure', () => {
    expect(settleRemittanceLine(facts())).toEqual({
      reportedCents: 2000,
      keptCents: 513,
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
