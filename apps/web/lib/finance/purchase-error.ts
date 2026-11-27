import { ApiError } from '@platform/api-client'
import {
  PaymentReturnRule,
  PaymentRule,
  PurchaseConflicts,
  PurchaseDocumentProblems,
  PurchaseRule
} from '@platform/core/domain'

// What the api says about a purchase that its error code alone does not: why a valid request was refused by the state of the purchase
// (`metadata.conflict`, one of PurchaseConflicts) and which rule of purchases a request broke (`metadata.problems`, the names of
// PurchaseRule and PaymentRule). Each has its own message, so the person reads what to change and not "something went wrong". Null when
// the error carries none the screen knows: the caller then shows the message of its code.
const CONFLICTS: readonly string[] = Object.values(PurchaseConflicts)
const RULES: readonly string[] = [
  ...Object.values(PurchaseRule),
  ...Object.values(PaymentRule),
  ...Object.values(PaymentReturnRule),
  ...Object.values(PurchaseDocumentProblems)
]

export type PurchaseErrorKey = `conflicts.${string}` | `rules.${string}`

export function purchaseErrorKeyOf(error: unknown): PurchaseErrorKey | null {
  if (!(error instanceof ApiError)) return null
  const conflict = error.metadata['conflict']
  if (typeof conflict === 'string' && CONFLICTS.includes(conflict)) return `conflicts.${conflict}`
  const problems = error.metadata['problems']
  if (Array.isArray(problems)) {
    const known = problems.find(
      (problem): problem is string => typeof problem === 'string' && RULES.includes(problem)
    )
    if (known !== undefined) return `rules.${known}`
  }
  return null
}
