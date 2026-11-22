import { randomUUID } from 'node:crypto'

// The owner of the claim of a fiscal submission. A type of its own so that it cannot be passed where a reason or an id is expected
// (every write of an attempt compares it with the one the row holds).
export type ClaimToken = string & { readonly __claimToken: unique symbol }

export const newClaimToken = (): ClaimToken => randomUUID() as ClaimToken
