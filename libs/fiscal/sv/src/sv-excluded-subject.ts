import { ExcludedSubjectProblems } from '@platform/core/domain'
import type { FiscalExcludedSubjectPurchaseInput } from '@platform/fiscal/sdk'

import { SV_GENERATION_CODE, SvExcludedSubject } from './sv-constants'
import { classificationProblems } from './sv-purchase-document'

// What is wrong in a purchase from an excluded subject by the manual of annexes F-07 (annex 5, p.27-31). It is checked when a person writes the
// purchase, so the annex of a month never has to guess. Pure and total: a list of codes of core's `ExcludedSubjectProblems`, empty when right.
export function excludedSubjectPurchaseProblems(
  input: FiscalExcludedSubjectPurchaseInput
): readonly string[] {
  const problems: string[] = []
  problems.push(...sellerProblems(input.sellerDocumentType, input.sellerDocumentNumber))
  // Both of the electronic document or none; the seal is text the authority gave, whose shape is not the manual's to fix
  if (input.generationCode !== null && !SV_GENERATION_CODE.test(input.generationCode)) {
    problems.push(ExcludedSubjectProblems.GENERATION_CODE_INVALID)
  }
  if (input.documentSeries !== null && input.documentSeries.trim() === '') {
    problems.push(ExcludedSubjectProblems.SERIES_INVALID)
  }
  if (!vatWithheldFits(input.amountCents, input.vatWithheldCents)) {
    problems.push(ExcludedSubjectProblems.VAT_WITHHELD_INVALID)
  }
  if (!(SvExcludedSubject.OPERATION_TYPES as readonly string[]).includes(input.operationType)) {
    problems.push(ExcludedSubjectProblems.OPERATION_TYPE_INVALID)
  }
  // The same table as the annex 3; the code is core's own for this kind of purchase
  if (classificationProblems(input).length > 0) {
    problems.push(ExcludedSubjectProblems.CLASSIFICATION_INVALID)
  }
  return problems
}

// The column B: a NIT is 14 digits, a DUI 9 digits and another document up to 14 characters, never with dashes (p.28)
function sellerProblems(type: string, number: string): string[] {
  const { SELLER_NIT, SELLER_DUI, SELLER_OTHER, NIT_LENGTH, DUI_LENGTH, OTHER_MAX_LENGTH } =
    SvExcludedSubject
  if (type === SELLER_NIT) {
    return new RegExp(`^[0-9]{${NIT_LENGTH}}$`, 'u').test(number)
      ? []
      : [ExcludedSubjectProblems.SELLER_DOCUMENT_NUMBER_INVALID]
  }
  if (type === SELLER_DUI) {
    return new RegExp(`^[0-9]{${DUI_LENGTH}}$`, 'u').test(number)
      ? []
      : [ExcludedSubjectProblems.SELLER_DOCUMENT_NUMBER_INVALID]
  }
  if (type === SELLER_OTHER) {
    return new RegExp(`^[A-Za-z0-9]{1,${OTHER_MAX_LENGTH}}$`, 'u').test(number)
      ? []
      : [ExcludedSubjectProblems.SELLER_DOCUMENT_NUMBER_INVALID]
  }
  return [ExcludedSubjectProblems.SELLER_DOCUMENT_TYPE_INVALID]
}

// The column H is 13 % of the amount when it applies and 0.00 when it does not (p.28). Whether it applies is the buyer's fact (the provider cannot
// know it), so 0.00 is always accepted; a figure must be the 13 % within a cent, the rounding of the invoice (half up on the whole amount).
function vatWithheldFits(amountCents: number, vatWithheldCents: number): boolean {
  if (vatWithheldCents === 0) return true
  const expected = Math.floor(
    (amountCents * SvExcludedSubject.VAT_WITHHOLDING_BPS + 5_000) / 10_000
  )
  return Math.abs(vatWithheldCents - expected) <= 1
}
