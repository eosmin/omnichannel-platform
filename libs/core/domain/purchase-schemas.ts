import { z } from 'zod'

import { FinanceLimits } from './finance-constants'
import { isIsoDate } from './ledger-days'
import { PURCHASE_ANNEX_EXCLUSIONS, PURCHASE_ORIGINS, PurchaseLimits } from './purchase-constants'
import { lowercasedUuidSchema, singleLineText } from './validation'

// The bodies of the purchase routes (TDD_18 §2.7, §12), in the shared lib: the api validates with them and the web checks what each
// form sends against the very same schema (a spec of the web), so the two cannot drift. The queries stay in the api (they carry its
// cursor).

// A calendar day, not only a string that looks like one (no 31 of February)
const day = z.string().refine(isIsoDate, { message: 'not a calendar date (YYYY-MM-DD)' })
// The key of a request, once per form: a double click or a retry after a lost answer is the same request
export const purchaseIdempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/)
const cents = z.number().int().min(0).max(FinanceLimits.MAX_LINE_CENTS)
const quantity = z.number().int().min(1).max(PurchaseLimits.MAX_LINE_QUANTITY)
const reason = singleLineText(FinanceLimits.MEMO_MAX_LENGTH, 1)
const nothingToChange = { message: 'nothing to change' }

const supplierFields = {
  name: singleLineText(PurchaseLimits.SUPPLIER_NAME_MAX_LENGTH, 1),
  taxId: singleLineText(PurchaseLimits.SUPPLIER_TAX_ID_MAX_LENGTH, 1),
  contactName: singleLineText(PurchaseLimits.SUPPLIER_CONTACT_MAX_LENGTH, 1),
  email: z.email().max(PurchaseLimits.SUPPLIER_EMAIL_MAX_LENGTH),
  phone: singleLineText(PurchaseLimits.SUPPLIER_PHONE_MAX_LENGTH, 1),
  paymentTermsDays: z.number().int().min(0).max(PurchaseLimits.MAX_PAYMENT_TERMS_DAYS),
  defaultPayableAccountId: lowercasedUuidSchema
}

export const createSupplierSchema = z.strictObject({
  name: supplierFields.name,
  taxId: supplierFields.taxId.optional(),
  contactName: supplierFields.contactName.optional(),
  email: supplierFields.email.optional(),
  phone: supplierFields.phone.optional(),
  paymentTermsDays: supplierFields.paymentTermsDays.default(0),
  defaultPayableAccountId: supplierFields.defaultPayableAccountId.optional()
})

// A field set to null is taken away; one left out stays. The payable account is chosen, never taken away by a change of mind: a
// supplier with bills keeps it (the service says so), and one without can name another.
export const updateSupplierSchema = z
  .strictObject({
    name: supplierFields.name.optional(),
    taxId: supplierFields.taxId.nullable().optional(),
    contactName: supplierFields.contactName.nullable().optional(),
    email: supplierFields.email.nullable().optional(),
    phone: supplierFields.phone.nullable().optional(),
    paymentTermsDays: supplierFields.paymentTermsDays.optional(),
    defaultPayableAccountId: supplierFields.defaultPayableAccountId.nullable().optional(),
    active: z.boolean().optional()
  })
  .refine(body => Object.values(body).some(value => value !== undefined), nothingToChange)

const orderLine = z.strictObject({
  productId: lowercasedUuidSchema,
  variantId: lowercasedUuidSchema.optional(),
  quantity,
  // The cost of ONE unit before tax
  unitCostCents: cents,
  taxRateId: lowercasedUuidSchema.optional()
})

const orderLines = z.array(orderLine).max(PurchaseLimits.MAX_LINES_PER_ORDER)

export const createPurchaseOrderSchema = z.strictObject({
  idempotencyKey: purchaseIdempotencyKey,
  supplierId: lowercasedUuidSchema,
  warehouseId: lowercasedUuidSchema,
  expectedOn: day.optional(),
  notes: singleLineText(PurchaseLimits.NOTES_MAX_LENGTH, 1).optional(),
  lines: orderLines.default([])
})

// Only a draft is changed. The lines, when sent, are the whole list: they replace the ones it had
export const updatePurchaseOrderSchema = z
  .strictObject({
    supplierId: lowercasedUuidSchema.optional(),
    warehouseId: lowercasedUuidSchema.optional(),
    expectedOn: day.nullable().optional(),
    notes: singleLineText(PurchaseLimits.NOTES_MAX_LENGTH, 1).nullable().optional(),
    lines: orderLines.optional()
  })
  .refine(body => Object.values(body).some(value => value !== undefined), nothingToChange)

// The supplier's document as the annex of purchases of the return reads it (D4b). Core only bounds the SHAPE of each value (short digits, a
// code of generation of letters, digits and dashes); what the codes mean and which combinations are valid is the provider's rule, checked
// when it is written (`FiscalDocumentProvider.validatePurchaseDocument`)
const documentCode = z
  .string()
  .regex(new RegExp(`^[0-9]{1,${PurchaseLimits.DOCUMENT_CODE_MAX_LENGTH}}$`))
export const purchaseFiscalDocumentSchema = z.strictObject({
  documentClass: documentCode,
  documentType: documentCode,
  // Only a received electronic document has one
  generationCode: z
    .string()
    .regex(new RegExp(`^[A-Za-z0-9-]{1,${PurchaseLimits.GENERATION_CODE_MAX_LENGTH}}$`))
    .optional(),
  origin: z.enum(PURCHASE_ORIGINS),
  // The classification of the cost or expense for the income tax: class (cost or expense), sector and type
  expenseClass: documentCode,
  sector: documentCode,
  costType: documentCode
})
export type PurchaseFiscalDocumentBody = z.infer<typeof purchaseFiscalDocumentSchema>

// Completing a receipt: the data of its document, or the mark that the annex leaves it out (and why). Never both
export const completeReceiptDocumentSchema = z.union([
  z.strictObject({ fiscalDocument: purchaseFiscalDocumentSchema }),
  z.strictObject({ annexExclusion: z.enum(PURCHASE_ANNEX_EXCLUSIONS) })
])

// What arrives: the lines of the order it takes in and how many units of each. The cost and the tax are the order's, never the client's
export const receivePurchaseOrderSchema = z.strictObject({
  idempotencyKey: purchaseIdempotencyKey,
  receivedOn: day,
  supplierDocumentNumber: singleLineText(FinanceLimits.DOCUMENT_NUMBER_MAX_LENGTH, 1).optional(),
  // Whether the tax of the bill is input VAT. Left out, it is when the supplier's document number is given [ACCOUNTANT]
  taxCreditable: z.boolean().optional(),
  fiscalDocument: purchaseFiscalDocumentSchema.optional(),
  lines: z
    .array(z.strictObject({ orderLineId: lowercasedUuidSchema, quantity }))
    .min(1)
    .max(PurchaseLimits.MAX_LINES_PER_ORDER)
    .refine(lines => new Set(lines.map(line => line.orderLineId)).size === lines.length, {
      message: 'a line of the order is received once per receipt'
    })
})

// Closing a purchase that arrived short, or cancelling one that was never received: the reason is for the audit log
export const closePurchaseOrderSchema = z.strictObject({ reason: reason.optional() })

export const recordPaymentSchema = z.strictObject({
  idempotencyKey: purchaseIdempotencyKey,
  paidFromAccountId: lowercasedUuidSchema,
  amountCents: z.number().int().min(1).max(FinanceLimits.MAX_LINE_CENTS),
  paidOn: day,
  // The bill it pays; left out, it is a payment on what the supplier is owed in all
  purchaseReceiptId: lowercasedUuidSchema.optional(),
  reference: singleLineText(PurchaseLimits.REFERENCE_MAX_LENGTH, 1).optional()
})

export const voidPaymentSchema = z.strictObject({ reason })

// What a supplier gave back of one payment (HC-121): the bank returned it or it bounced. The payment is the one of the route.
export const recordPaymentReturnSchema = z.strictObject({
  idempotencyKey: purchaseIdempotencyKey,
  // The cash, bank or wallet account the money came back into
  receivedIntoAccountId: lowercasedUuidSchema,
  amountCents: z.number().int().min(1).max(FinanceLimits.MAX_LINE_CENTS),
  returnedOn: day,
  reference: singleLineText(PurchaseLimits.REFERENCE_MAX_LENGTH, 1).optional()
})

export const voidPaymentReturnSchema = z.strictObject({ reason })
