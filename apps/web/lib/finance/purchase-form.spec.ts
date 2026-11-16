import type { PurchaseOrderLineView, PurchaseOrderView, SupplierView } from '@platform/api-client'
import { PurchaseOrderStatus, TaxRounding } from '@platform/core/domain'
import {
  closePurchaseOrderSchema,
  createPurchaseOrderSchema,
  createSupplierSchema,
  receivePurchaseOrderSchema,
  recordPaymentSchema,
  updatePurchaseOrderSchema,
  updateSupplierSchema,
  voidPaymentSchema
} from '@platform/core/finance'

import {
  centsOfText,
  createOrderInputOf,
  createSupplierInputOf,
  dayOfDate,
  daysPastDue,
  decimalOfCentsText,
  emptyOrderHeaderDraft,
  emptyPaymentDraft,
  emptySupplierDraft,
  type LineDraft,
  lineInputsOf,
  lineProblem,
  linesProblem,
  moneyOfLines,
  orderActionsOf,
  OrderActions,
  orderHeaderProblem,
  paymentInputOf,
  paymentProblem,
  pendingOf,
  receiveDraftOf,
  receiveInputOf,
  receiveProblem,
  supplierDraftOf,
  supplierProblem,
  updateSupplierInputOf,
  wholeOfText
} from './purchase-form'

const UUID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const KEY = 'a-key-of-the-form-0001'

const supplier: SupplierView = {
  id: UUID(1),
  name: 'Distribuidora Sur',
  taxId: '0614-010101-101-0',
  contactName: null,
  email: 'ventas@example.com',
  phone: null,
  paymentTermsDays: 30,
  defaultPayableAccountId: UUID(2),
  active: true,
  createdAt: '2026-11-01T10:00:00.000Z'
}

const orderLine = (over: Partial<PurchaseOrderLineView> = {}): PurchaseOrderLineView => ({
  id: UUID(10),
  storeId: UUID(3),
  lineNo: 1,
  productId: UUID(4),
  variantId: null,
  quantity: 10,
  receivedQuantity: 0,
  unitCostCents: 1550,
  taxRateId: UUID(5),
  ...over
})

const order = (over: Partial<PurchaseOrderView> = {}): PurchaseOrderView => ({
  id: UUID(20),
  number: 'PO-000001',
  supplierId: UUID(1),
  warehouseId: UUID(6),
  status: PurchaseOrderStatus.ORDERED,
  orderedOn: '2026-11-10',
  expectedOn: null,
  notes: null,
  createdBy: UUID(7),
  createdAt: '2026-11-10T10:00:00.000Z',
  lines: [orderLine()],
  receipts: [],
  ...over
})

describe('centsOfText', () => {
  it('turns dollars into whole cents by the digits, with a point or a comma', () => {
    expect(centsOfText('15')).toBe(1500)
    expect(centsOfText('15.5')).toBe(1550)
    expect(centsOfText('15,05')).toBe(1505)
    expect(centsOfText('0.05')).toBe(5)
    expect(centsOfText(' 0.10 ')).toBe(10)
    // 0.07 * 100 is 7.000000000000001 in a float: the digits never go through one
    expect(centsOfText('1.15')).toBe(115)
    expect(centsOfText('0.29')).toBe(29)
  })

  it('refuses what is not an amount: a sign, a letter, a third decimal, a thousands separator or one above a line', () => {
    for (const text of ['', '-1', 'abc', '1.234', '1,000.00', '1e3', '.5', '5.', '99999999999']) {
      expect(centsOfText(text)).toBeNull()
    }
  })

  it('writes back what it reads', () => {
    expect(decimalOfCentsText(1550)).toBe('15.50')
    expect(decimalOfCentsText(5)).toBe('0.05')
    expect(centsOfText(decimalOfCentsText(123456))).toBe(123456)
  })
})

describe('whole numbers and days', () => {
  it('reads whole numbers only', () => {
    expect(wholeOfText('12')).toBe(12)
    expect(wholeOfText('1.5')).toBeNull()
    expect(wholeOfText('-1')).toBeNull()
    expect(wholeOfText('')).toBeNull()
  })

  it('writes the accounting day of a clock and counts the days past due by the calendar', () => {
    expect(dayOfDate(new Date(2026, 10, 5))).toBe('2026-11-05')
    expect(daysPastDue('2026-11-01', '2026-11-16')).toBe(15)
    expect(daysPastDue('2026-11-16', '2026-11-16')).toBe(0)
    expect(daysPastDue('2026-12-01', '2026-11-16')).toBe(0)
    // Across a change of month and of year
    expect(daysPastDue('2026-12-30', '2027-01-02')).toBe(3)
  })
})

describe('the supplier form', () => {
  it('needs a name and keeps the rest to the limits of the api', () => {
    expect(supplierProblem(emptySupplierDraft())).toBe('name')
    expect(supplierProblem({ ...emptySupplierDraft(), name: 'A' })).toBeNull()
    expect(supplierProblem({ ...emptySupplierDraft(), name: 'A', email: 'not-an-email' })).toBe(
      'email'
    )
    expect(supplierProblem({ ...emptySupplierDraft(), name: 'A', paymentTermsDays: '366' })).toBe(
      'paymentTermsDays'
    )
    expect(supplierProblem({ ...emptySupplierDraft(), name: 'A', paymentTermsDays: '-1' })).toBe(
      'paymentTermsDays'
    )
  })

  it('sends a body the api takes (its own schema decides), with the fields left empty left out', () => {
    const input = createSupplierInputOf({
      ...emptySupplierDraft(),
      name: ' Distribuidora Sur ',
      taxId: ' 0614-010101-101-0 ',
      email: 'ventas@example.com',
      paymentTermsDays: '30',
      defaultPayableAccountId: UUID(2)
    })
    expect(input).toEqual({
      name: 'Distribuidora Sur',
      taxId: '0614-010101-101-0',
      email: 'ventas@example.com',
      paymentTermsDays: 30,
      defaultPayableAccountId: UUID(2)
    })
    expect(createSupplierSchema.safeParse(input).success).toBe(true)
    expect(
      createSupplierSchema.safeParse(createSupplierInputOf({ ...emptySupplierDraft(), name: 'A' }))
        .success
    ).toBe(true)
  })

  it('sends only what changed; an emptied text field is taken away and the payable account is never', () => {
    const draft = supplierDraftOf(supplier)
    expect(updateSupplierInputOf(supplier, draft)).toEqual({})
    const changes = updateSupplierInputOf(supplier, {
      ...draft,
      name: 'Otro nombre',
      taxId: '',
      phone: '2222-0000',
      paymentTermsDays: '45',
      defaultPayableAccountId: ''
    })
    expect(changes).toEqual({
      name: 'Otro nombre',
      taxId: null,
      phone: '2222-0000',
      paymentTermsDays: 45
    })
    expect(updateSupplierSchema.safeParse(changes).success).toBe(true)
    expect(updateSupplierSchema.safeParse({}).success).toBe(false)
  })
})

describe('the header of an order', () => {
  it('needs a supplier and a warehouse and a real expected day when one is given', () => {
    expect(orderHeaderProblem(emptyOrderHeaderDraft())).toBe('supplierId')
    const draft = { ...emptyOrderHeaderDraft(), supplierId: UUID(1) }
    expect(orderHeaderProblem(draft)).toBe('warehouseId')
    const full = { ...draft, warehouseId: UUID(6) }
    expect(orderHeaderProblem(full)).toBeNull()
    expect(orderHeaderProblem({ ...full, expectedOn: '2026-02-31' })).toBe('expectedOn')
    expect(orderHeaderProblem({ ...full, expectedOn: '2026-11-30' })).toBeNull()
  })

  it('makes a draft with no lines, with the key of the form, in the shape of the api', () => {
    const input = createOrderInputOf(
      {
        supplierId: UUID(1),
        warehouseId: UUID(6),
        expectedOn: '2026-11-30',
        notes: ' Entrega en bodega '
      },
      KEY
    )
    expect(input).toEqual({
      idempotencyKey: KEY,
      supplierId: UUID(1),
      warehouseId: UUID(6),
      expectedOn: '2026-11-30',
      notes: 'Entrega en bodega'
    })
    expect(createPurchaseOrderSchema.safeParse(input).success).toBe(true)
  })
})

describe('the lines of a draft', () => {
  const line = (over: Partial<LineDraft> = {}): LineDraft => ({
    key: 'k1',
    productId: UUID(4),
    variantId: '',
    label: 'Camisa',
    quantity: '10',
    unitCost: '15.50',
    taxRateId: '',
    ...over
  })

  it('points at the first wrong line and the field that is wrong', () => {
    expect(lineProblem(line())).toBeNull()
    expect(lineProblem(line({ quantity: '0' }))).toBe('quantity')
    expect(lineProblem(line({ quantity: '1.5' }))).toBe('quantity')
    expect(lineProblem(line({ unitCost: '' }))).toBe('unitCost')
    expect(lineProblem(line({ unitCost: '1.234' }))).toBe('unitCost')
    expect(lineProblem(line({ productId: '' }))).toBe('item')
    // A line above the largest amount a line holds can never be received
    expect(lineProblem(line({ quantity: '1000000', unitCost: '10000' }))).toBe('unitCost')
    expect(linesProblem([line(), line({ quantity: 'x' })])).toEqual({ index: 1, field: 'quantity' })
    expect(linesProblem([line()])).toBeNull()
  })

  it('sends the whole list in the order shown, as the api takes it', () => {
    const lines = lineInputsOf([
      line(),
      line({ key: 'k2', variantId: UUID(8), quantity: '3', unitCost: '0.05', taxRateId: UUID(5) })
    ])
    expect(lines).toEqual([
      { productId: UUID(4), quantity: 10, unitCostCents: 1550 },
      { productId: UUID(4), variantId: UUID(8), quantity: 3, unitCostCents: 5, taxRateId: UUID(5) }
    ])
    expect(updatePurchaseOrderSchema.safeParse({ lines }).success).toBe(true)
    // The list may be emptied, and a draft with no lines is still a draft
    expect(updatePurchaseOrderSchema.safeParse({ lines: lineInputsOf([]) }).success).toBe(true)
  })

  it('shows the same money the api computes: the tax of each line rounded by the rule of the organization, line by line', () => {
    const rate = (id: string): number | null => (id === 'vat' ? 1300 : null)
    const money = moneyOfLines(
      [
        { quantity: 1, unitCostCents: 105, taxRateId: 'vat' },
        { quantity: 1, unitCostCents: 105, taxRateId: 'vat' },
        { quantity: 2, unitCostCents: 500, taxRateId: null }
      ],
      rate,
      TaxRounding.HALF_UP
    )
    // 105 x 13 % = 13.65 -> 14 per line, so 28 and not the 27 of rounding the sum
    expect(money.taxCents).toBe(28)
    expect(money.subtotalCents).toBe(1210)
    expect(money.totalCents).toBe(1238)
  })
})

describe('what an order allows', () => {
  it('follows the table of the api, and does not offer a cancel once goods arrived', () => {
    expect(orderActionsOf(order({ status: PurchaseOrderStatus.DRAFT }))).toEqual([
      OrderActions.EDIT,
      OrderActions.ORDER,
      OrderActions.CANCEL
    ])
    expect(orderActionsOf(order({ status: PurchaseOrderStatus.ORDERED }))).toEqual([
      OrderActions.RECEIVE,
      OrderActions.CANCEL
    ])
    const partly = order({ status: PurchaseOrderStatus.PARTIALLY_RECEIVED })
    expect(orderActionsOf(partly)).toEqual([OrderActions.RECEIVE, OrderActions.CLOSE])
    // A received order may still be closed (the table of the api says so)
    expect(orderActionsOf(order({ status: PurchaseOrderStatus.RECEIVED }))).toEqual([
      OrderActions.CLOSE
    ])
    for (const status of [PurchaseOrderStatus.CLOSED, PurchaseOrderStatus.CANCELLED]) {
      expect(orderActionsOf(order({ status }))).toEqual([])
    }
  })

  it('says a cancel needs no receipt even where the table allows it', () => {
    const received = order({
      status: PurchaseOrderStatus.ORDERED,
      receipts: [{ id: UUID(30) } as PurchaseOrderView['receipts'][number]]
    })
    expect(orderActionsOf(received)).not.toContain(OrderActions.CANCEL)
  })
})

describe('receiving', () => {
  const two = order({
    lines: [
      orderLine({ id: UUID(10), quantity: 10, receivedQuantity: 4 }),
      orderLine({ id: UUID(11), quantity: 5, receivedQuantity: 5 })
    ]
  })

  it('suggests what is still to come, and nothing for a line that is complete', () => {
    const draft = receiveDraftOf(two, '2026-11-16')
    expect(draft.quantities).toEqual({ [UUID(10)]: '6', [UUID(11)]: '0' })
    expect(draft.receivedOn).toBe('2026-11-16')
    expect(pendingOf(two.lines[0] as PurchaseOrderLineView)).toBe(6)
  })

  it('refuses more than is pending, a bad day, and a receipt of nothing', () => {
    const draft = receiveDraftOf(two, '2026-11-16')
    expect(receiveProblem(two, draft)).toBeNull()
    expect(
      receiveProblem(two, { ...draft, quantities: { ...draft.quantities, [UUID(10)]: '7' } })
    ).toEqual({
      field: 'quantity',
      lineId: UUID(10)
    })
    expect(receiveProblem(two, { ...draft, receivedOn: '2026-13-01' })?.field).toBe('receivedOn')
    expect(
      receiveProblem(two, { ...draft, quantities: { [UUID(10)]: '0', [UUID(11)]: '' } })?.field
    ).toBe('nothing')
  })

  it('sends the lines that arrive, with the key of the form, in the shape of the api', () => {
    const draft = {
      ...receiveDraftOf(two, '2026-11-16'),
      supplierDocumentNumber: ' FAC-1001 ',
      quantities: { [UUID(10)]: '3', [UUID(11)]: '0' }
    }
    const input = receiveInputOf(two, draft, KEY)
    expect(input).toEqual({
      idempotencyKey: KEY,
      receivedOn: '2026-11-16',
      supplierDocumentNumber: 'FAC-1001',
      lines: [{ orderLineId: UUID(10), quantity: 3 }]
    })
    expect(receivePurchaseOrderSchema.safeParse(input).success).toBe(true)
    // Only "no" is said: left out, the api credits the tax when there is a document number
    const notCredited = receiveInputOf(two, { ...draft, creditTax: false }, KEY)
    expect(notCredited.taxCreditable).toBe(false)
    expect(receivePurchaseOrderSchema.safeParse(notCredited).success).toBe(true)
    expect('taxCreditable' in input).toBe(false)
  })
})

describe('a payment', () => {
  const draft = {
    ...emptyPaymentDraft('2026-11-16', { receiptId: UUID(40), openCents: 12_345 }),
    paidFromAccountId: UUID(41)
  }

  it('suggests the open amount of the bill and the day of today', () => {
    expect(draft.amount).toBe('123.45')
    expect(draft.paidOn).toBe('2026-11-16')
    expect(draft.purchaseReceiptId).toBe(UUID(40))
    expect(emptyPaymentDraft('2026-11-16').purchaseReceiptId).toBe('')
  })

  it('needs an account, an amount above 0 and not above what is open, and a real day', () => {
    expect(paymentProblem(draft, 12_345)).toBeNull()
    expect(paymentProblem({ ...draft, paidFromAccountId: '' }, 12_345)).toBe('paidFromAccountId')
    expect(paymentProblem({ ...draft, amount: '0' }, 12_345)).toBe('amount')
    expect(paymentProblem({ ...draft, amount: '123.46' }, 12_345)).toBe('amount')
    expect(paymentProblem({ ...draft, amount: '1.234' }, 12_345)).toBe('amount')
    expect(paymentProblem({ ...draft, paidOn: '2026-02-30' }, 12_345)).toBe('paidOn')
  })

  it('sends cents and the key of the form, in the shape of the api', () => {
    const input = paymentInputOf({ ...draft, reference: ' Transferencia 889 ' }, KEY)
    expect(input).toEqual({
      idempotencyKey: KEY,
      paidFromAccountId: UUID(41),
      amountCents: 12_345,
      paidOn: '2026-11-16',
      purchaseReceiptId: UUID(40),
      reference: 'Transferencia 889'
    })
    expect(recordPaymentSchema.safeParse(input).success).toBe(true)
    const onAccount = paymentInputOf({ ...draft, purchaseReceiptId: '' }, KEY)
    expect('purchaseReceiptId' in onAccount).toBe(false)
    expect(recordPaymentSchema.safeParse(onAccount).success).toBe(true)
  })
})

describe('the reason', () => {
  it('is the body the api takes to void a payment, to close an order and to cancel one', () => {
    expect(voidPaymentSchema.safeParse({ reason: 'Se pagó dos veces' }).success).toBe(true)
    expect(voidPaymentSchema.safeParse({}).success).toBe(false)
    expect(closePurchaseOrderSchema.safeParse({}).success).toBe(true)
    expect(closePurchaseOrderSchema.safeParse({ reason: 'No llegó' }).success).toBe(true)
  })
})
