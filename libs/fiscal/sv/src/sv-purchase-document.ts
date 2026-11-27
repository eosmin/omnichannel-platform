import { PurchaseDocumentProblems, PurchaseOrigins } from '@platform/core/domain'
import type { FiscalPurchaseDocumentInput } from '@platform/fiscal/sdk'

import {
  SV_GENERATION_CODE,
  SV_PURCHASE_OTHER_TYPES,
  SV_PURCHASE_SUPPLIER_TYPES,
  SvPurchaseClass,
  SvPurchaseClassification,
  SvPurchaseType
} from './sv-constants'

const CLASSES: readonly string[] = Object.values(SvPurchaseClass)
const TYPES: readonly string[] = [...SV_PURCHASE_SUPPLIER_TYPES, ...SV_PURCHASE_OTHER_TYPES]

// What is wrong in the supplier's document of a purchase by the manual of annexes F-07 (annex 3). It is checked when a person writes it, so
// the annex of a month never has to guess. Pure and total: a list of codes of core's `PurchaseDocumentProblems`, empty when it is right.
export function purchaseDocumentProblems(input: FiscalPurchaseDocumentInput): readonly string[] {
  const problems: string[] = []
  problems.push(...issuedProblems(input.issuedOn, input.receivedOn))
  const classOk = CLASSES.includes(input.documentClass)
  const typeOk = TYPES.includes(input.documentType)
  if (!classOk) problems.push(PurchaseDocumentProblems.CLASS_INVALID)
  if (!typeOk) problems.push(PurchaseDocumentProblems.TYPE_INVALID)
  if (classOk && typeOk) {
    const other = input.documentClass === SvPurchaseClass.OTHER
    const allowed = other ? SV_PURCHASE_OTHER_TYPES : SV_PURCHASE_SUPPLIER_TYPES
    if (!allowed.includes(input.documentType))
      problems.push(PurchaseDocumentProblems.CLASS_TYPE_MISMATCH)
  }
  if (input.documentNumber === null || input.documentNumber.trim() === '') {
    problems.push(PurchaseDocumentProblems.NUMBER_REQUIRED)
  }
  const electronic = input.documentClass === SvPurchaseClass.DTE
  if (electronic && input.generationCode === null) {
    problems.push(PurchaseDocumentProblems.GENERATION_CODE_REQUIRED)
  } else if (electronic && !SV_GENERATION_CODE.test(input.generationCode ?? '')) {
    problems.push(PurchaseDocumentProblems.GENERATION_CODE_INVALID)
  } else if (!electronic && input.generationCode !== null) {
    problems.push(PurchaseDocumentProblems.GENERATION_CODE_NOT_ELECTRONIC)
  }
  if (typeOk && !originFits(input.documentType, input.origin)) {
    problems.push(PurchaseDocumentProblems.ORIGIN_INVALID_FOR_TYPE)
  }
  problems.push(...classificationProblems(input))
  return problems
}

// The day of issue is not after the day the goods arrived, and the return takes a document of up to three periods before the one it is
// declared in (article 63 of the law of VAT, manual p.17). Both are calendar days written YYYY-MM-DD, compared as text and by month
// arithmetic: no instant, no time zone, so the day of El Salvador is the day that was written.
const MONTHS_BACK = 3
const monthIndex = (day: string): number => Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7))
function issuedProblems(issuedOn: string, receivedOn: string): string[] {
  if (issuedOn > receivedOn) return [PurchaseDocumentProblems.ISSUED_AFTER_RECEIPT]
  return monthIndex(receivedOn) - monthIndex(issuedOn) > MONTHS_BACK
    ? [PurchaseDocumentProblems.ISSUED_TOO_OLD]
    : []
}

// A document of a supplier is a purchase in the country; the declaration of goods is the internation or the import of goods; the payment
// order of the treasury is the import of services
function originFits(type: string, origin: string): boolean {
  if (type === SvPurchaseType.CUSTOMS_DECLARATION) {
    return origin === PurchaseOrigins.INTERNATION || origin === PurchaseOrigins.IMPORT_GOODS
  }
  if (type === SvPurchaseType.PAYMENT_ORDER) return origin === PurchaseOrigins.IMPORT_SERVICES
  return origin === PurchaseOrigins.INTERNAL
}

// Columns R, S and T: a cost goes with a sector and a cost type of the table; an expense with any sector and its three types
function classificationProblems(input: FiscalPurchaseDocumentInput): string[] {
  const { COST, EXPENSE, SECTORS, SECTOR_INDUSTRY } = SvPurchaseClassification
  if (input.expenseClass !== COST && input.expenseClass !== EXPENSE) {
    return [PurchaseDocumentProblems.CLASSIFICATION_INVALID]
  }
  if (!(SECTORS as readonly string[]).includes(input.sector)) {
    return [PurchaseDocumentProblems.CLASSIFICATION_INVALID]
  }
  const types: readonly string[] =
    input.expenseClass === EXPENSE
      ? SvPurchaseClassification.EXPENSE_TYPES
      : input.sector === SECTOR_INDUSTRY
        ? SvPurchaseClassification.COST_TYPES_INDUSTRY
        : SvPurchaseClassification.COST_TYPES_OTHER_SECTORS
  return types.includes(input.costType) ? [] : [PurchaseDocumentProblems.CLASSIFICATION_INVALID]
}
