import { dateToDay } from '@platform/core/finance'

// What suppliers, purchase orders, receipts and payments look like to the api (TDD_18 §2.7). Dates are the accounting day
// ('YYYY-MM-DD'); money is whole USD cents.

export const SUPPLIER_SELECT = {
  id: true,
  name: true,
  taxId: true,
  contactName: true,
  email: true,
  phone: true,
  paymentTermsDays: true,
  defaultPayableAccountId: true,
  active: true,
  createdAt: true
} as const

export interface SupplierRow {
  id: string
  name: string
  taxId: string | null
  contactName: string | null
  email: string | null
  phone: string | null
  paymentTermsDays: number
  defaultPayableAccountId: string | null
  active: boolean
  createdAt: Date
}

export interface SupplierView extends Omit<SupplierRow, 'createdAt'> {
  createdAt: string
}

export const supplierView = (row: SupplierRow): SupplierView => ({
  ...row,
  createdAt: row.createdAt.toISOString()
})

export interface SupplierPage {
  data: SupplierView[]
  nextCursor: string | null
  hasMore: boolean
}

export const ORDER_LINE_SELECT = {
  id: true,
  storeId: true,
  lineNo: true,
  productId: true,
  variantId: true,
  quantity: true,
  receivedQuantity: true,
  unitCostCents: true,
  taxRateId: true
} as const

export interface OrderLineRow {
  id: string
  storeId: string
  lineNo: number
  productId: string
  variantId: string | null
  quantity: number
  receivedQuantity: number
  unitCostCents: number
  taxRateId: string | null
}

export const RECEIPT_SELECT = {
  id: true,
  purchaseOrderId: true,
  supplierId: true,
  receivedOn: true,
  dueOn: true,
  supplierDocumentNumber: true,
  taxCreditable: true,
  subtotalCents: true,
  taxCents: true,
  totalCents: true,
  entryId: true,
  createdBy: true,
  createdAt: true
} as const

export const RECEIPT_LINE_SELECT = {
  id: true,
  storeId: true,
  receiptId: true,
  orderLineId: true,
  quantity: true,
  unitCostCents: true,
  subtotalCents: true,
  taxCents: true,
  movementId: true
} as const

export interface ReceiptRow {
  id: string
  purchaseOrderId: string
  supplierId: string
  receivedOn: Date
  dueOn: Date
  supplierDocumentNumber: string | null
  taxCreditable: boolean
  subtotalCents: number
  taxCents: number
  totalCents: number
  entryId: string
  createdBy: string
  createdAt: Date
}

export interface ReceiptLineRow {
  id: string
  storeId: string
  receiptId: string
  orderLineId: string
  quantity: number
  unitCostCents: number
  subtotalCents: number
  taxCents: number
  movementId: string
}

export interface ReceiptView {
  id: string
  purchaseOrderId: string
  supplierId: string
  receivedOn: string
  dueOn: string
  supplierDocumentNumber: string | null
  taxCreditable: boolean
  subtotalCents: number
  taxCents: number
  totalCents: number
  entryId: string
  createdBy: string
  createdAt: string
  // Only the lines of the stores the caller sees
  lines: ReceiptLineRow[]
}

export const receiptView = (row: ReceiptRow, lines: ReceiptLineRow[]): ReceiptView => ({
  id: row.id,
  purchaseOrderId: row.purchaseOrderId,
  supplierId: row.supplierId,
  receivedOn: dateToDay(row.receivedOn),
  dueOn: dateToDay(row.dueOn),
  supplierDocumentNumber: row.supplierDocumentNumber,
  taxCreditable: row.taxCreditable,
  subtotalCents: row.subtotalCents,
  taxCents: row.taxCents,
  totalCents: row.totalCents,
  entryId: row.entryId,
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
  lines
})

export const ORDER_SELECT = {
  id: true,
  number: true,
  supplierId: true,
  warehouseId: true,
  status: true,
  orderedOn: true,
  expectedOn: true,
  notes: true,
  createdBy: true,
  createdAt: true
} as const

export interface OrderRow {
  id: string
  number: string
  supplierId: string
  warehouseId: string
  status: string
  orderedOn: Date | null
  expectedOn: Date | null
  notes: string | null
  createdBy: string
  createdAt: Date
}

export interface OrderView {
  id: string
  number: string
  supplierId: string
  warehouseId: string
  status: string
  orderedOn: string | null
  expectedOn: string | null
  notes: string | null
  createdBy: string
  createdAt: string
  // Only the lines of the stores the caller sees (TDD_18 §2.1)
  lines: OrderLineRow[]
  receipts: ReceiptView[]
}

export const orderView = (
  row: OrderRow,
  lines: OrderLineRow[],
  receipts: ReceiptView[]
): OrderView => ({
  id: row.id,
  number: row.number,
  supplierId: row.supplierId,
  warehouseId: row.warehouseId,
  status: row.status,
  orderedOn: row.orderedOn === null ? null : dateToDay(row.orderedOn),
  expectedOn: row.expectedOn === null ? null : dateToDay(row.expectedOn),
  notes: row.notes,
  createdBy: row.createdBy,
  createdAt: row.createdAt.toISOString(),
  lines,
  receipts
})

export interface OrderPage {
  data: OrderView[]
  nextCursor: string | null
  hasMore: boolean
}

export const PAYMENT_SELECT = {
  id: true,
  supplierId: true,
  purchaseReceiptId: true,
  paidFromAccountId: true,
  amountCents: true,
  paidOn: true,
  reference: true,
  entryId: true,
  voidedByEntryId: true,
  createdBy: true,
  createdAt: true
} as const

export interface PaymentRow {
  id: string
  supplierId: string
  purchaseReceiptId: string | null
  paidFromAccountId: string
  amountCents: number
  paidOn: Date
  reference: string | null
  entryId: string
  voidedByEntryId: string | null
  createdBy: string
  createdAt: Date
}

export interface PaymentView extends Omit<PaymentRow, 'paidOn' | 'createdAt'> {
  paidOn: string
  createdAt: string
}

export const paymentView = (row: PaymentRow): PaymentView => ({
  ...row,
  paidOn: dateToDay(row.paidOn),
  createdAt: row.createdAt.toISOString()
})

export interface PaymentPage {
  data: PaymentView[]
  nextCursor: string | null
  hasMore: boolean
}

// What a supplier is owed in all: bills minus the live payments, and the part of it past its due day
export interface SupplierBalanceView {
  supplierId: string
  billedCents: number
  paidCents: number
  openCents: number
  overdueCents: number
}

export interface PayableBillView {
  receiptId: string
  purchaseOrderId: string
  supplierId: string
  supplierDocumentNumber: string | null
  receivedOn: string
  dueOn: string
  totalCents: number
  openCents: number
  overdue: boolean
}

export interface PayablesView {
  bills: PayableBillView[]
  suppliers: SupplierBalanceView[]
}
