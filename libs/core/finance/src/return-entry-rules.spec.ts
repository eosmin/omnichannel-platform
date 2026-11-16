import {
  AccountRole,
  FinancePostingFailureReason,
  PartyType,
  ReturnCostAgainst,
  ReturnSettlementKind
} from '@platform/core/domain'

import {
  type DraftLine,
  lineBases,
  openReceivableCents,
  returnLines,
  restockCost,
  reversalLinesOf,
  reversalOf,
  type RoleAccounts,
  saleAmounts,
  writeOffLines
} from './index'

const accounts: RoleAccounts = role => `acc-${role}`
const STORE = 'store-1'
const CARRIER = 'conn-1'

const sum = (lines: readonly DraftLine[], side: 'debitCents' | 'creditCents'): number =>
  lines.reduce((total, line) => total + line[side], 0)
const lineOf = (lines: readonly DraftLine[], role: AccountRole): DraftLine | undefined =>
  lines.find(line => line.accountId === `acc-${role}`)

describe('openReceivableCents (E7)', () => {
  it('is what the carrier had to collect less what every confirmed remittance cleared', () => {
    // 100.00 to collect; a first remittance reported 80.00 and kept 5.00, a second one reported 10.00 and kept nothing
    expect(
      openReceivableCents(10000, [
        { reportedCents: 8000, deductedCents: 500 },
        { reportedCents: 1000, deductedCents: 0 }
      ])
    ).toBe(500)
  })

  it('is negative when the carrier paid more than the guide was worth', () => {
    expect(openReceivableCents(10000, [{ reportedCents: 10100, deductedCents: 0 }])).toBe(-100)
  })
})

describe('openReceivableCents with a fee larger than the cash (E7, HC-001)', () => {
  it('counts only what the remittance took out of the cash, so a fee above it leaves no surplus behind', () => {
    // 25.99 to collect; the carrier reported nothing and its 30.00 fee took the whole 25.99 out of the cash: nothing is open, nothing is over
    expect(openReceivableCents(2599, [{ reportedCents: 0, deductedCents: 2599 }])).toBe(0)
  })
})

describe('writeOffLines (E7)', () => {
  it('writes a shortfall off against the carrier receivable, with the carrier as the party', () => {
    const result = writeOffLines({
      accounts,
      carrierConnectionId: CARRIER,
      openCents: 500,
      storeId: STORE
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(lineOf(result.lines, AccountRole.COD_DIFFERENCES)).toMatchObject({
      debitCents: 500,
      creditCents: 0
    })
    expect(lineOf(result.lines, AccountRole.RECEIVABLE_CARRIERS)).toMatchObject({
      debitCents: 0,
      creditCents: 500,
      partyType: PartyType.CARRIER_CONNECTION,
      partyId: CARRIER
    })
    expect(sum(result.lines, 'debitCents')).toBe(sum(result.lines, 'creditCents'))
  })

  it('reinstates the receivable for a surplus, the other way round', () => {
    const result = writeOffLines({
      accounts,
      carrierConnectionId: CARRIER,
      openCents: -100,
      storeId: STORE
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(lineOf(result.lines, AccountRole.RECEIVABLE_CARRIERS)?.debitCents).toBe(100)
    expect(lineOf(result.lines, AccountRole.COD_DIFFERENCES)?.creditCents).toBe(100)
  })

  it('posts nothing when nothing is open, and names a role with no account', () => {
    expect(
      writeOffLines({ accounts, carrierConnectionId: CARRIER, openCents: 0, storeId: STORE })
    ).toEqual({
      ok: true,
      lines: []
    })
    const none: RoleAccounts = role => (role === AccountRole.COD_DIFFERENCES ? null : `acc-${role}`)
    expect(
      writeOffLines({ accounts: none, carrierConnectionId: CARRIER, openCents: 5, storeId: STORE })
    ).toEqual({
      ok: false,
      reason: FinancePostingFailureReason.ROLE_NOT_MAPPED,
      role: AccountRole.COD_DIFFERENCES
    })
  })
})

// 3 units at 10.00 and 1 at 4.00, 5.00 off the order, prices without tax at 13%: gross 34.00, discount shared by weight
const order = {
  subtotalCents: 3400,
  shippingCents: 300,
  discountCents: 500,
  // 29.00 of revenue, 3.77 of tax and 3.00 of shipping
  totalCents: 3577,
  taxCents: 333 + 44,
  pricesIncludeTax: false as boolean | null,
  lines: [
    { orderItemId: 'a', quantity: 3, unitPriceCents: 1000, taxCents: 333 },
    { orderItemId: 'b', quantity: 1, unitPriceCents: 400, taxCents: 44 }
  ]
}

describe('lineBases (E8)', () => {
  it('splits the order the way the sale does: the parts add up to the sale revenue and tax', () => {
    const bases = lineBases(order)
    expect(bases.ok).toBe(true)
    if (!bases.ok) return
    const sale = saleAmounts({ ...order, lines: order.lines })
    expect(sale.ok).toBe(true)
    if (!sale.ok) return
    expect(bases.lines.reduce((total, line) => total + line.netCents, 0)).toBe(
      sale.amounts.revenueNetCents
    )
    expect(bases.lines.reduce((total, line) => total + line.vatCents, 0)).toBe(
      order.lines.reduce((total, line) => total + line.taxCents, 0)
    )
  })

  it('refuses an order with no tax recorded and one that does not add up', () => {
    expect(lineBases({ ...order, taxCents: null })).toEqual({
      ok: false,
      reason: FinancePostingFailureReason.TAX_MISSING
    })
    expect(
      lineBases({
        ...order,
        lines: order.lines.map((line, index) => (index === 0 ? { ...line, taxCents: null } : line))
      })
    ).toEqual({ ok: false, reason: FinancePostingFailureReason.TAX_MISSING })
    expect(lineBases({ ...order, subtotalCents: 3500 })).toEqual({
      ok: false,
      reason: FinancePostingFailureReason.AMOUNTS_DISAGREE
    })
  })
})

describe('reversalOf (E8)', () => {
  const bases = (() => {
    const result = lineBases(order)
    if (!result.ok) throw new Error('fixture')
    return result.lines
  })()
  const net = (id: string): number => bases.find(line => line.orderItemId === id)?.netCents ?? 0
  const vat = (id: string): number => bases.find(line => line.orderItemId === id)?.vatCents ?? 0

  it('reverses the whole sale of a line when all its units come back', () => {
    const result = reversalOf({
      bases,
      before: new Map(),
      returned: new Map([
        ['a', 3],
        ['b', 1]
      ])
    })
    expect(result).toEqual({
      ok: true,
      reversal: { netCents: net('a') + net('b'), vatCents: vat('a') + vat('b') }
    })
  })

  it('adds up to the sale to the cent whatever the way the units come back', () => {
    let netTotal = 0
    let vatTotal = 0
    let before = 0
    for (const step of [1, 1, 1]) {
      const result = reversalOf({
        bases,
        before: new Map([['a', before]]),
        returned: new Map([['a', step]])
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      netTotal += result.reversal.netCents
      vatTotal += result.reversal.vatCents
      before += step
    }
    expect(netTotal).toBe(net('a'))
    expect(vatTotal).toBe(vat('a'))
  })

  it('refuses more units back than were sold and a unit that is not on the order', () => {
    expect(
      reversalOf({ bases, before: new Map([['b', 1]]), returned: new Map([['b', 1]]) })
    ).toEqual({ ok: false, reason: FinancePostingFailureReason.AMOUNTS_DISAGREE })
    expect(reversalOf({ bases, before: new Map(), returned: new Map([['zzz', 1]]) })).toEqual({
      ok: false,
      reason: FinancePostingFailureReason.AMOUNTS_DISAGREE
    })
  })
})

describe('reversalLinesOf (E8, line by line)', () => {
  const bases = (() => {
    const result = lineBases(order)
    if (!result.ok) throw new Error('fixture')
    return result.lines
  })()

  it('adds up to what reversalOf gives, in the order of the bases', () => {
    const input = {
      bases,
      before: new Map([['a', 1]]),
      returned: new Map([
        ['b', 1],
        ['a', 2]
      ])
    }
    const lines = reversalLinesOf(input)
    const total = reversalOf(input)
    expect(lines.ok && total.ok).toBe(true)
    if (!lines.ok || !total.ok) return
    expect(lines.lines.map(line => line.orderItemId)).toEqual(
      bases.map(basis => basis.orderItemId).filter(id => id === 'a' || id === 'b')
    )
    expect(lines.lines.reduce((sum, line) => sum + line.netCents, 0)).toBe(total.reversal.netCents)
    expect(lines.lines.reduce((sum, line) => sum + line.vatCents, 0)).toBe(total.reversal.vatCents)
    expect(lines.lines.find(line => line.orderItemId === 'a')?.quantity).toBe(2)
  })

  it('refuses more units back than were sold and a unit that is not on the order', () => {
    const refused = { ok: false, reason: FinancePostingFailureReason.AMOUNTS_DISAGREE }
    expect(
      reversalLinesOf({ bases, before: new Map([['b', 1]]), returned: new Map([['b', 1]]) })
    ).toEqual(refused)
    expect(reversalLinesOf({ bases, before: new Map(), returned: new Map([['zzz', 1]]) })).toEqual(
      refused
    )
  })
})

describe('returnLines (E8)', () => {
  const reversal = { netCents: 2000, vatCents: 260 }

  it('after the sale reverses revenue and tax against the customer advance, and puts the cost back from the cost of goods sold', () => {
    const result = returnLines({
      accounts,
      reversal,
      settlement: { kind: ReturnSettlementKind.ADVANCE },
      restockCostCents: 1200,
      costAgainst: ReturnCostAgainst.COST_OF_GOODS_SOLD,
      storeId: STORE
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(lineOf(result.lines, AccountRole.SALES_RETURNS)?.debitCents).toBe(2000)
    expect(lineOf(result.lines, AccountRole.VAT_OUTPUT)?.debitCents).toBe(260)
    expect(lineOf(result.lines, AccountRole.CUSTOMER_ADVANCES)?.creditCents).toBe(2260)
    expect(lineOf(result.lines, AccountRole.INVENTORY)?.debitCents).toBe(1200)
    expect(lineOf(result.lines, AccountRole.COST_OF_GOODS_SOLD)?.creditCents).toBe(1200)
    expect(sum(result.lines, 'debitCents')).toBe(3460)
    expect(sum(result.lines, 'debitCents')).toBe(sum(result.lines, 'creditCents'))
  })

  it('credits the carrier receivable, with its party, when the carrier will never remit', () => {
    const result = returnLines({
      accounts,
      reversal,
      settlement: { kind: ReturnSettlementKind.CARRIER, carrierConnectionId: CARRIER },
      restockCostCents: 0,
      costAgainst: ReturnCostAgainst.COST_OF_GOODS_SOLD,
      storeId: STORE
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(lineOf(result.lines, AccountRole.RECEIVABLE_CARRIERS)).toMatchObject({
      creditCents: 2260,
      partyType: PartyType.CARRIER_CONNECTION,
      partyId: CARRIER
    })
    expect(lineOf(result.lines, AccountRole.INVENTORY)).toBeUndefined()
  })

  it('before the sale only moves the cost back from inventory in transit', () => {
    const result = returnLines({
      accounts,
      reversal: null,
      settlement: { kind: ReturnSettlementKind.ADVANCE },
      restockCostCents: 1200,
      costAgainst: ReturnCostAgainst.TRANSIT,
      storeId: STORE
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.lines.map(line => [line.accountId, line.debitCents, line.creditCents])).toEqual([
      [`acc-${AccountRole.INVENTORY}`, 1200, 0],
      [`acc-${AccountRole.INVENTORY_IN_TRANSIT}`, 0, 1200]
    ])
  })

  it('posts nothing when there is nothing to reverse and nothing back, and names a role with no account', () => {
    expect(
      returnLines({
        accounts,
        reversal: null,
        settlement: { kind: ReturnSettlementKind.ADVANCE },
        restockCostCents: 0,
        costAgainst: ReturnCostAgainst.TRANSIT,
        storeId: STORE
      })
    ).toEqual({ ok: true, lines: [] })
    const none: RoleAccounts = role => (role === AccountRole.SALES_RETURNS ? null : `acc-${role}`)
    expect(
      returnLines({
        accounts: none,
        reversal,
        settlement: { kind: ReturnSettlementKind.ADVANCE },
        restockCostCents: 0,
        costAgainst: ReturnCostAgainst.COST_OF_GOODS_SOLD,
        storeId: STORE
      })
    ).toEqual({
      ok: false,
      reason: FinancePostingFailureReason.ROLE_NOT_MAPPED,
      role: AccountRole.SALES_RETURNS
    })
  })
})

describe('restockCost (E8)', () => {
  const issued = [
    { productId: 'p', variantId: null, quantity: 2, unitCostCents: 400 },
    { productId: 'p', variantId: null, quantity: 1, unitCostCents: 410 }
  ]

  it('takes the cost the movement recorded when it has one', () => {
    expect(
      restockCost([{ productId: 'p', variantId: null, quantity: 3, unitCostCents: 450 }], issued)
    ).toEqual({ ok: true, costCents: 1350 })
  })

  it('values a unit that came back with no cost at what its sale took it out at, to the cent', () => {
    // 1210 of cost for 3 units: one unit is 403.33 and a quantity of 3 is the whole 1210
    expect(
      restockCost([{ productId: 'p', variantId: null, quantity: 1, unitCostCents: null }], issued)
    ).toEqual({ ok: true, costCents: 403 })
    expect(
      restockCost([{ productId: 'p', variantId: null, quantity: 3, unitCostCents: null }], issued)
    ).toEqual({ ok: true, costCents: 1210 })
  })

  it('leaves no cent behind when a product comes back in several pieces', () => {
    const piece = { productId: 'p', variantId: null, quantity: 1, unitCostCents: null }
    // 1000 cents of cost for 3 units: three pieces of one unit are the whole 1000, not 3 x 333
    expect(
      restockCost(
        [piece, piece, piece],
        [{ productId: 'p', variantId: null, quantity: 3, unitCostCents: null }]
      )
    ).toEqual({
      ok: false,
      reason: FinancePostingFailureReason.COST_MISSING
    })
    expect(
      restockCost(
        [piece, piece, piece],
        [
          { productId: 'p', variantId: null, quantity: 1, unitCostCents: 334 },
          { productId: 'p', variantId: null, quantity: 2, unitCostCents: 333 }
        ]
      )
    ).toEqual({ ok: true, costCents: 1000 })
  })

  it('refuses a unit with no cost of its own and none from its sale, never a cost of zero', () => {
    expect(
      restockCost([{ productId: 'q', variantId: null, quantity: 1, unitCostCents: null }], issued)
    ).toEqual({ ok: false, reason: FinancePostingFailureReason.COST_MISSING })
    expect(
      restockCost(
        [{ productId: 'p', variantId: null, quantity: 1, unitCostCents: null }],
        [{ productId: 'p', variantId: null, quantity: 1, unitCostCents: null }]
      )
    ).toEqual({ ok: false, reason: FinancePostingFailureReason.COST_MISSING })
    expect(restockCost([], issued)).toEqual({ ok: true, costCents: 0 })
  })
})

describe('returnLines with the shipping fee (E8)', () => {
  it('reverses the shipping and its tax with the carrier receivable, for the whole receivable E3 debited', () => {
    const result = returnLines({
      accounts,
      reversal: { netCents: 2000, vatCents: 260 },
      shipping: { netCents: 500, vatCents: 65 },
      settlement: { kind: ReturnSettlementKind.CARRIER, carrierConnectionId: CARRIER },
      restockCostCents: 0,
      costAgainst: ReturnCostAgainst.COST_OF_GOODS_SOLD,
      storeId: STORE
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(lineOf(result.lines, AccountRole.SHIPPING_REVENUE)?.debitCents).toBe(500)
    expect(lineOf(result.lines, AccountRole.VAT_OUTPUT)?.debitCents).toBe(325)
    expect(lineOf(result.lines, AccountRole.RECEIVABLE_CARRIERS)?.creditCents).toBe(2825)
    expect(sum(result.lines, 'debitCents')).toBe(sum(result.lines, 'creditCents'))
  })
})
