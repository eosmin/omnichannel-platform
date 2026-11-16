import { type VoidReasonProblem, voidReasonProblem } from './void-form'

// The reason a person gives when they confirm that a refused document is not at the issuer it was made with: it goes to the audit log. It is
// the same text as the reason of a void (one line, up to the same limit), so the rule is the void's and is kept in one place.
export type IssuerChangeReasonProblem = VoidReasonProblem
export const issuerChangeReasonProblem = voidReasonProblem
