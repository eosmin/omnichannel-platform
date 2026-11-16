import { z } from 'zod'

import type {
  CreatePurchaseOrderInput,
  CreateSupplierInput,
  PurchaseOrderLineView,
  PurchaseOrderView,
  ReceivePurchaseOrderInput,
  RecordSupplierPaymentInput,
  SupplierView,
  UpdatePurchaseOrderInput,
  UpdateSupplierInput
} from '@platform/api-client'
import {
  FinanceLimits,
  isIsoDate,
  PurchaseLimits,
  PurchaseOrderStatus,
  PurchaseOrderStatusTransitions,
  type ReceiptMoney,
  receiptMoney,
  type TaxRounding
} from '@platform/core/domain'

import { decimalOfCents } from './money'

// The forms of suppliers, purchase orders, receiving and payments (TDD_18 §2.7, Step 4B.9a-4). Pure: the screens only draw what these
// say. Money is typed as decimal text and turned into whole cents by the digits (never through a float); the totals shown are the
// ones the api computes, because they come from the same rule (`receiptMoney`).

const DECIMAL_MONEY = /^(\d{1,10})(?:[.,](\d{1,2}))?$/

// "15.5" -> 1550, "15" -> 1500, "0.05" -> 5; a sign, a letter, a third decimal or a thousands separator is not an amount (null)
export function centsOfText(text: string): number | null {
  const match = DECIMAL_MONEY.exec(text.trim())
  if (match === null) return null
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
  return cents <= FinanceLimits.MAX_LINE_CENTS ? cents : null
}

const WHOLE = /^\d{1,7}$/
export const wholeOfText = (text: string): number | null =>
  WHOLE.test(text.trim()) ? Number(text) : null

// The accounting day of the person's clock (the api allows a day ahead, for the zone of the person)
export const dayOfDate = (date: Date): string =>
  `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

// A key per attempt: a double click or a retry after a lost answer is the same request (the api answers the first again)
export const newIdempotencyKey = (): string => crypto.randomUUID()

const trimmed = (text: string): string | undefined => {
  const value = text.trim()
  return value === '' ? undefined : value
}

// ---------------------------------------------------------------------------------------------------------------- suppliers

export interface SupplierDraft {
  name: string
  taxId: string
  contactName: string
  email: string
  phone: string
  paymentTermsDays: string
  defaultPayableAccountId: string
  active: boolean
}

export const SupplierFields = {
  NAME: 'name',
  TAX_ID: 'taxId',
  CONTACT_NAME: 'contactName',
  EMAIL: 'email',
  PHONE: 'phone',
  PAYMENT_TERMS: 'paymentTermsDays'
} as const
export type SupplierField = (typeof SupplierFields)[keyof typeof SupplierFields]

export const emptySupplierDraft = (): SupplierDraft => ({
  name: '',
  taxId: '',
  contactName: '',
  email: '',
  phone: '',
  paymentTermsDays: '0',
  defaultPayableAccountId: '',
  active: true
})

export const supplierDraftOf = (supplier: SupplierView): SupplierDraft => ({
  name: supplier.name,
  taxId: supplier.taxId ?? '',
  contactName: supplier.contactName ?? '',
  email: supplier.email ?? '',
  phone: supplier.phone ?? '',
  paymentTermsDays: String(supplier.paymentTermsDays),
  defaultPayableAccountId: supplier.defaultPayableAccountId ?? '',
  active: supplier.active
})

export function supplierProblem(draft: SupplierDraft): SupplierField | null {
  const name = draft.name.trim()
  if (name === '' || name.length > PurchaseLimits.SUPPLIER_NAME_MAX_LENGTH) {
    return SupplierFields.NAME
  }
  if (draft.taxId.trim().length > PurchaseLimits.SUPPLIER_TAX_ID_MAX_LENGTH) {
    return SupplierFields.TAX_ID
  }
  if (draft.contactName.trim().length > PurchaseLimits.SUPPLIER_CONTACT_MAX_LENGTH) {
    return SupplierFields.CONTACT_NAME
  }
  const email = draft.email.trim()
  if (
    email !== '' &&
    (!z.email().safeParse(email).success || email.length > PurchaseLimits.SUPPLIER_EMAIL_MAX_LENGTH)
  ) {
    return SupplierFields.EMAIL
  }
  if (draft.phone.trim().length > PurchaseLimits.SUPPLIER_PHONE_MAX_LENGTH) {
    return SupplierFields.PHONE
  }
  const days = wholeOfText(draft.paymentTermsDays)
  if (days === null || days > PurchaseLimits.MAX_PAYMENT_TERMS_DAYS) {
    return SupplierFields.PAYMENT_TERMS
  }
  return null
}

// Call only after `supplierProblem` said null
export function createSupplierInputOf(draft: SupplierDraft): CreateSupplierInput {
  const input: CreateSupplierInput = {
    name: draft.name.trim(),
    paymentTermsDays: wholeOfText(draft.paymentTermsDays) ?? 0
  }
  const taxId = trimmed(draft.taxId)
  const contactName = trimmed(draft.contactName)
  const email = trimmed(draft.email)
  const phone = trimmed(draft.phone)
  if (taxId !== undefined) input.taxId = taxId
  if (contactName !== undefined) input.contactName = contactName
  if (email !== undefined) input.email = email
  if (phone !== undefined) input.phone = phone
  if (draft.defaultPayableAccountId !== '') {
    input.defaultPayableAccountId = draft.defaultPayableAccountId
  }
  return input
}

// Only what differs. A text field that was emptied is taken away (null); the payable account is never taken away (the api says why),
// so an account left blank is "no change".
export function updateSupplierInputOf(
  supplier: SupplierView,
  draft: SupplierDraft
): UpdateSupplierInput {
  const changes: UpdateSupplierInput = {}
  if (draft.name.trim() !== supplier.name) changes.name = draft.name.trim()
  const text = (
    key: 'taxId' | 'contactName' | 'email' | 'phone',
    was: string | null,
    now: string
  ): void => {
    const value = now.trim()
    if (value === (was ?? '')) return
    changes[key] = value === '' ? null : value
  }
  text('taxId', supplier.taxId, draft.taxId)
  text('contactName', supplier.contactName, draft.contactName)
  text('email', supplier.email, draft.email)
  text('phone', supplier.phone, draft.phone)
  const days = wholeOfText(draft.paymentTermsDays)
  if (days !== null && days !== supplier.paymentTermsDays) changes.paymentTermsDays = days
  if (
    draft.defaultPayableAccountId !== '' &&
    draft.defaultPayableAccountId !== supplier.defaultPayableAccountId
  ) {
    changes.defaultPayableAccountId = draft.defaultPayableAccountId
  }
  if (draft.active !== supplier.active) changes.active = draft.active
  return changes
}

// ---------------------------------------------------------------------------------------------------------------- orders

export interface OrderHeaderDraft {
  supplierId: string
  warehouseId: string
  expectedOn: string
  notes: string
}

export const OrderHeaderFields = {
  SUPPLIER: 'supplierId',
  WAREHOUSE: 'warehouseId',
  EXPECTED_ON: 'expectedOn',
  NOTES: 'notes'
} as const
export type OrderHeaderField = (typeof OrderHeaderFields)[keyof typeof OrderHeaderFields]

export const emptyOrderHeaderDraft = (): OrderHeaderDraft => ({
  supplierId: '',
  warehouseId: '',
  expectedOn: '',
  notes: ''
})

export function orderHeaderProblem(draft: OrderHeaderDraft): OrderHeaderField | null {
  if (draft.supplierId === '') return OrderHeaderFields.SUPPLIER
  if (draft.warehouseId === '') return OrderHeaderFields.WAREHOUSE
  if (draft.expectedOn.trim() !== '' && !isIsoDate(draft.expectedOn.trim())) {
    return OrderHeaderFields.EXPECTED_ON
  }
  if (draft.notes.trim().length > PurchaseLimits.NOTES_MAX_LENGTH) return OrderHeaderFields.NOTES
  return null
}

// The order is made empty and its lines are edited on its own page (a draft, so nothing is promised to the supplier yet)
export function createOrderInputOf(
  draft: OrderHeaderDraft,
  idempotencyKey: string
): CreatePurchaseOrderInput {
  const input: CreatePurchaseOrderInput = {
    idempotencyKey,
    supplierId: draft.supplierId,
    warehouseId: draft.warehouseId
  }
  const expectedOn = trimmed(draft.expectedOn)
  const notes = trimmed(draft.notes)
  if (expectedOn !== undefined) input.expectedOn = expectedOn
  if (notes !== undefined) input.notes = notes
  return input
}

export interface LineDraft {
  // A key of the screen, so a row keeps its fields when another one is taken away
  key: string
  productId: string
  variantId: string
  // What the person sees of the item
  label: string
  quantity: string
  unitCost: string
  taxRateId: string
}

export const LineFields = {
  ITEM: 'item',
  QUANTITY: 'quantity',
  UNIT_COST: 'unitCost'
} as const
export type LineField = (typeof LineFields)[keyof typeof LineFields]

export const lineDraftOf = (line: PurchaseOrderLineView, label: string): LineDraft => ({
  key: line.id,
  productId: line.productId,
  variantId: line.variantId ?? '',
  label,
  quantity: String(line.quantity),
  unitCost: decimalOfCentsText(line.unitCostCents),
  taxRateId: line.taxRateId ?? ''
})

// 1550 -> "15.50": the digits of a cost already in whole cents, for the box that edits it
export const decimalOfCentsText = (cents: number): string => decimalOfCents(cents)

export function lineProblem(line: LineDraft): LineField | null {
  if (line.productId === '') return LineFields.ITEM
  const quantity = wholeOfText(line.quantity)
  if (quantity === null || quantity < 1 || quantity > PurchaseLimits.MAX_LINE_QUANTITY) {
    return LineFields.QUANTITY
  }
  const cost = centsOfText(line.unitCost)
  if (cost === null) return LineFields.UNIT_COST
  // A line above the largest amount a line may hold can never be received: refused here, not at the door
  if (quantity * cost > FinanceLimits.MAX_LINE_CENTS) return LineFields.UNIT_COST
  return null
}

// The first line that is wrong, with the field: the screen points at it
export function linesProblem(
  lines: readonly LineDraft[]
): { index: number; field: LineField } | null {
  for (const [index, line] of lines.entries()) {
    const field = lineProblem(line)
    if (field !== null) return { index, field }
  }
  return null
}

// What the lines are replaced with: the whole list, in the order shown. Call only after `linesProblem` said null.
export function lineInputsOf(
  lines: readonly LineDraft[]
): NonNullable<UpdatePurchaseOrderInput['lines']> {
  return lines.map(line => ({
    productId: line.productId,
    ...(line.variantId === '' ? {} : { variantId: line.variantId }),
    quantity: wholeOfText(line.quantity) ?? 0,
    unitCostCents: centsOfText(line.unitCost) ?? 0,
    ...(line.taxRateId === '' ? {} : { taxRateId: line.taxRateId })
  }))
}

// The money of a list of lines, by the rule of the api: the tax of each line rounded by the organization's rule, line by line.
// `rateBpsOf` answers the rate of a tax rate id (null: untaxed).
export function moneyOfLines(
  lines: ReadonlyArray<{ quantity: number; unitCostCents: number; taxRateId: string | null }>,
  rateBpsOf: (taxRateId: string) => number | null,
  rounding: TaxRounding
): ReceiptMoney {
  return receiptMoney(
    lines.map(line => ({
      quantity: line.quantity,
      unitCostCents: line.unitCostCents,
      rateBps: line.taxRateId === null ? null : rateBpsOf(line.taxRateId)
    })),
    rounding
  )
}

// What can be done with an order in the state it is in, from the table the api keeps (never a second copy of it)
export const OrderActions = {
  EDIT: 'edit',
  ORDER: 'order',
  RECEIVE: 'receive',
  CLOSE: 'close',
  CANCEL: 'cancel'
} as const
export type OrderAction = (typeof OrderActions)[keyof typeof OrderActions]

export function orderActionsOf(
  order: Pick<PurchaseOrderView, 'status' | 'receipts'>
): OrderAction[] {
  const next = PurchaseOrderStatusTransitions[order.status]
  const actions: OrderAction[] = []
  if (order.status === PurchaseOrderStatus.DRAFT) actions.push(OrderActions.EDIT)
  if (next.includes(PurchaseOrderStatus.ORDERED)) actions.push(OrderActions.ORDER)
  // Receiving goes on while something is open (ordered or partly received)
  if (
    order.status === PurchaseOrderStatus.ORDERED ||
    order.status === PurchaseOrderStatus.PARTIALLY_RECEIVED
  ) {
    actions.push(OrderActions.RECEIVE)
  }
  if (next.includes(PurchaseOrderStatus.CLOSED)) actions.push(OrderActions.CLOSE)
  // The api refuses to cancel an order that has a receipt: the button is not offered
  if (next.includes(PurchaseOrderStatus.CANCELLED) && order.receipts.length === 0) {
    actions.push(OrderActions.CANCEL)
  }
  return actions
}

// ---------------------------------------------------------------------------------------------------------------- receiving

export interface ReceiveDraft {
  receivedOn: string
  supplierDocumentNumber: string
  // The tax is credited as input VAT; with the box on, the api credits it when the supplier's document number is given [ACCOUNTANT]
  creditTax: boolean
  // The units arriving now, per line of the order, as typed
  quantities: Record<string, string>
}

export const ReceiveFields = {
  DATE: 'receivedOn',
  DOCUMENT: 'supplierDocumentNumber',
  QUANTITY: 'quantity',
  NOTHING: 'nothing'
} as const
export type ReceiveField = (typeof ReceiveFields)[keyof typeof ReceiveFields]

// The suggestion of the form: today, the whole of what is still to come on each line
export const receiveDraftOf = (
  order: Pick<PurchaseOrderView, 'lines'>,
  today: string
): ReceiveDraft => ({
  receivedOn: today,
  supplierDocumentNumber: '',
  creditTax: true,
  quantities: Object.fromEntries(
    order.lines.map(line => [line.id, String(Math.max(0, line.quantity - line.receivedQuantity))])
  )
})

export const pendingOf = (
  line: Pick<PurchaseOrderLineView, 'quantity' | 'receivedQuantity'>
): number => Math.max(0, line.quantity - line.receivedQuantity)

export function receiveProblem(
  order: Pick<PurchaseOrderView, 'lines'>,
  draft: ReceiveDraft
): { field: ReceiveField; lineId: string | null } | null {
  if (!isIsoDate(draft.receivedOn.trim())) return { field: ReceiveFields.DATE, lineId: null }
  if (draft.supplierDocumentNumber.trim().length > FinanceLimits.DOCUMENT_NUMBER_MAX_LENGTH) {
    return { field: ReceiveFields.DOCUMENT, lineId: null }
  }
  let any = false
  for (const line of order.lines) {
    const text = (draft.quantities[line.id] ?? '0').trim()
    const quantity = wholeOfText(text === '' ? '0' : text)
    if (quantity === null || quantity > pendingOf(line)) {
      return { field: ReceiveFields.QUANTITY, lineId: line.id }
    }
    if (quantity > 0) any = true
  }
  return any ? null : { field: ReceiveFields.NOTHING, lineId: null }
}

// The lines with units to take in, in the order of the order. Call only after `receiveProblem` said null.
export function receiveInputOf(
  order: Pick<PurchaseOrderView, 'lines'>,
  draft: ReceiveDraft,
  idempotencyKey: string
): ReceivePurchaseOrderInput {
  const lines = order.lines.flatMap(line => {
    const quantity = wholeOfText((draft.quantities[line.id] ?? '0').trim() || '0') ?? 0
    return quantity > 0 ? [{ orderLineId: line.id, quantity }] : []
  })
  const document = trimmed(draft.supplierDocumentNumber)
  return {
    idempotencyKey,
    receivedOn: draft.receivedOn.trim(),
    ...(document === undefined ? {} : { supplierDocumentNumber: document }),
    // Left out the api decides (credited when there is a document number); only "no" is said
    ...(draft.creditTax ? {} : { taxCreditable: false }),
    lines
  }
}

// ---------------------------------------------------------------------------------------------------------------- payments

export interface PaymentDraft {
  paidFromAccountId: string
  amount: string
  paidOn: string
  reference: string
  // The bill it pays; '' is a payment on what the supplier is owed in all
  purchaseReceiptId: string
}

export const PaymentFields = {
  ACCOUNT: 'paidFromAccountId',
  AMOUNT: 'amount',
  DATE: 'paidOn',
  REFERENCE: 'reference'
} as const
export type PaymentField = (typeof PaymentFields)[keyof typeof PaymentFields]

export const emptyPaymentDraft = (
  today: string,
  bill?: { receiptId: string; openCents: number }
): PaymentDraft => ({
  paidFromAccountId: '',
  amount: bill === undefined ? '' : decimalOfCentsText(bill.openCents),
  paidOn: today,
  reference: '',
  purchaseReceiptId: bill?.receiptId ?? ''
})

export function paymentProblem(draft: PaymentDraft, openCents: number | null): PaymentField | null {
  if (draft.paidFromAccountId === '') return PaymentFields.ACCOUNT
  const amount = centsOfText(draft.amount)
  // A payment is never zero, and never above what is open (the api checks it again against the ledger, under a lock)
  if (amount === null || amount < 1 || (openCents !== null && amount > openCents)) {
    return PaymentFields.AMOUNT
  }
  if (!isIsoDate(draft.paidOn.trim())) return PaymentFields.DATE
  if (draft.reference.trim().length > PurchaseLimits.REFERENCE_MAX_LENGTH) {
    return PaymentFields.REFERENCE
  }
  return null
}

// Call only after `paymentProblem` said null
export function paymentInputOf(
  draft: PaymentDraft,
  idempotencyKey: string
): RecordSupplierPaymentInput {
  const reference = trimmed(draft.reference)
  return {
    idempotencyKey,
    paidFromAccountId: draft.paidFromAccountId,
    amountCents: centsOfText(draft.amount) ?? 0,
    paidOn: draft.paidOn.trim(),
    ...(draft.purchaseReceiptId === '' ? {} : { purchaseReceiptId: draft.purchaseReceiptId }),
    ...(reference === undefined ? {} : { reference })
  }
}

// The days a bill is past due: a day count between two accounting days, by the calendar and not by 24-hour blocks
export function daysPastDue(dueOn: string, today: string): number {
  const day = (text: string): number => {
    const [year, month, date] = text.split('-').map(Number)
    return Date.UTC(year ?? 0, (month ?? 1) - 1, date ?? 1) / 86_400_000
  }
  return Math.max(0, Math.round(day(today) - day(dueOn)))
}
