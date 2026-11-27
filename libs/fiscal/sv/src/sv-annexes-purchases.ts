import { PurchaseOrigins } from '@platform/core/domain'
import {
  FiscalAnnexError,
  type FiscalAnnexFile,
  type FiscalAnnexPeriod,
  type FiscalAnnexPurchase
} from '@platform/fiscal/sdk'

import { annexMoney, dateCell, digitsOf, fileOf, periodKey, textCell } from './sv-annexes'
import { SvAnnex, SvAnnexErrors, SvAnnexIds, SvPurchaseClass } from './sv-constants'
import { purchaseDocumentProblems } from './sv-purchase-document'
import { SvTaxIdShapes, isValidSvNationalId } from './sv-tax-id'

// The annex of purchases of the monthly VAT return (F-07, annex 3, columns A to U), "Manual de Anexos del Formulario de IVA F-07" version 14
// (January 2025), public (transparencia.mh.gob.sv). Pure, like the others: the receipts of the month in, the file out, the same bytes for the
// same receipts. The amounts are the ones the ledger kept (whole cents, split by the tax of the lines of the receipt), never recomputed:
// the credit of column N is the tax the receipt kept, and a receipt whose tax is not 13 % of its taxed operations (within a cent) is refused.
//
// Each row is a receipt of the month of its arrival (the credit is taken in the period it arrives in) whose supplier's document was written
// down: the date of column A is the day the supplier issued it, which may be up to three periods before (article 63, p.17).
// A document that is a credit note or a debit note is written with POSITIVE figures and its own type (the manual forbids negative values,
// p.18-19, and says column O adds the debit notes and subtracts the credit notes: the loader does it by the type). **[ACCOUNTANT]/owner**
// check it by loading the file in a real return without filing it.

const CLASSIFICATION_NONE = SvAnnex.ZERO

interface Row {
  readonly sort: readonly [string, string, string]
  readonly cells: readonly string[]
}

const centsOfRate = (base: number): number =>
  Number((BigInt(base) * SvAnnex.CREDIT_PERCENT * 2n + 100n) / 200n)

// The columns G to M by the origin of the purchase: [exempt, taxed]. The import of services has no column for what is exempt: it goes in the
// one of the imports (I), the one the manual keeps for the exempt imports. **[ACCOUNTANT]**
const COLUMNS: Readonly<Record<string, readonly [number, number]>> = {
  [PurchaseOrigins.INTERNAL]: [0, 3],
  [PurchaseOrigins.INTERNATION]: [1, 4],
  [PurchaseOrigins.IMPORT_GOODS]: [2, 5],
  [PurchaseOrigins.IMPORT_SERVICES]: [2, 6]
}

// The number of the supplier: a NIT (14 digits) or an NRC (2 to 8, no leading zeros) in column E, or the DUI of a person (9 digits, with its
// check digit) in column P, and then E is empty (p.18-19). A tax id that is none of them is refused: it is never guessed
function supplierCells(taxId: string | null): readonly [string, string] | null {
  const digits = digitsOf(taxId)
  if (digits.length === SvTaxIdShapes.TAX_NUMBER_DIGITS) return [digits, '']
  if (digits.length === SvTaxIdShapes.NATIONAL_ID_DIGITS) {
    return isValidSvNationalId(digits) ? ['', digits] : null
  }
  if (
    digits.length >= SvTaxIdShapes.REGISTRATION_MIN_DIGITS &&
    digits.length <= SvTaxIdShapes.REGISTRATION_MAX_DIGITS
  ) {
    return [digits.replace(/^0+/u, ''), '']
  }
  return null
}

function rowOf(
  purchase: FiscalAnnexPurchase,
  classified: boolean,
  refused: { document: string[]; supplier: string[]; amounts: string[] }
): Row | null {
  const doc = purchase.document
  const id = purchase.receiptId
  if (purchaseDocumentProblems(doc).length > 0) {
    refused.document.push(id)
    return null
  }
  const customs = doc.documentClass === SvPurchaseClass.OTHER
  const supplier = customs
    ? [SvAnnex.TREASURY_TAX_NUMBER, '']
    : supplierCells(purchase.supplierTaxId)
  if (supplier === null) {
    refused.supplier.push(id)
    return null
  }
  const taxed = purchase.taxedBaseCents
  const exempt = purchase.exemptBaseCents
  // A tax that is not credited is not the annex's, and the credit is the share of the taxed operations that the ledger kept
  const expected = centsOfRate(taxed)
  if (
    (!purchase.taxCreditable && purchase.taxCents > 0) ||
    Math.abs(purchase.taxCents - expected) >
      SvAnnex.CREDIT_TOLERANCE_CENTS_PER_LINE * Math.max(1, purchase.taxedLines)
  ) {
    refused.amounts.push(id)
    return null
  }
  const columns = COLUMNS[doc.origin] ?? [0, 3]
  const amounts = [0, 0, 0, 0, 0, 0, 0]
  amounts[columns[0]] = exempt
  amounts[columns[1]] = taxed
  const total = amounts.reduce((sum, value) => sum + value, 0)
  const number = (
    doc.documentClass === SvPurchaseClass.DTE
      ? (doc.generationCode ?? '').replaceAll('-', '').toUpperCase()
      : textCell(doc.documentNumber ?? '')
  ).slice(0, SvAnnex.DOCUMENT_NUMBER_MAX_LENGTH)
  const operation =
    taxed > 0 && exempt > 0
      ? SvAnnex.OPERATION_MIXED
      : taxed > 0
        ? SvAnnex.OPERATION_TAXED
        : SvAnnex.OPERATION_NOT_TAXED
  const cells = [
    dateCell(doc.issuedOn), // A fecha de emisión del documento del proveedor
    doc.documentClass, // B clase
    doc.documentType, // C tipo
    number, // D número de documento (the code of generation, no dashes, in a DTE)
    supplier[0], // E NIT o NRC
    customs ? SvAnnex.TREASURY_NAME : textCell(purchase.supplierName), // F nombre
    ...amounts.map(annexMoney), // G a M
    annexMoney(purchase.taxCents), // N crédito fiscal
    annexMoney(total), // O total de compras
    customs ? '' : supplier[1], // P DUI
    classified ? operation : CLASSIFICATION_NONE, // Q tipo de operación
    classified ? doc.expenseClass : CLASSIFICATION_NONE, // R clasificación
    classified ? doc.sector : CLASSIFICATION_NONE, // S sector
    classified ? doc.costType : CLASSIFICATION_NONE, // T tipo de costo o gasto
    SvAnnex.NUMBER_PURCHASES // U número de anexo
  ]
  if (number === '') {
    refused.document.push(id)
    return null
  }
  return { sort: [doc.issuedOn, purchase.receivedOn, id], cells }
}

export function purchasesAnnex(
  period: FiscalAnnexPeriod,
  purchases: readonly FiscalAnnexPurchase[]
): FiscalAnnexFile {
  const key = periodKey(period)
  const classified = key >= SvAnnex.PURCHASE_CLASSIFICATION_FROM
  const refused = { document: [] as string[], supplier: [] as string[], amounts: [] as string[] }
  const rows: Row[] = []
  for (const purchase of purchases) {
    if (purchase.receivedOn.slice(0, 7) !== key) continue
    const row = rowOf(purchase, classified, refused)
    if (row !== null) rows.push(row)
  }
  // One cause at a time, the document first: the staff fixes it and asks again
  for (const [code, ids] of [
    [SvAnnexErrors.PURCHASE_DOCUMENT, refused.document],
    [SvAnnexErrors.PURCHASE_SUPPLIER, refused.supplier],
    [SvAnnexErrors.PURCHASE_AMOUNTS, refused.amounts]
  ] as const) {
    if (ids.length > 0) throw new FiscalAnnexError(code, [...ids].sort())
  }
  rows.sort((a, b) =>
    a.sort.join('|') < b.sort.join('|') ? -1 : a.sort.join('|') > b.sort.join('|') ? 1 : 0
  )
  return fileOf(
    SvAnnexIds.PURCHASES,
    period,
    rows.map(row => row.cells)
  )
}
